import type { Config } from "../core/config.js";
import { assertValidEmbeddingDimensions } from "../core/embedding-dimensions.js";
import { SCHEMA_SQL } from "../embedded-assets.generated.js";
import { createEngine } from "./engine-factory.js";
import { runMigrations } from "./migrations/index.js";
import { resyncIdSequences } from "./sequence-sync.js";
import type { SqlConn, SqlExecutor } from "./sql-executor.js";
import { fingerprintString, readMeta, writeMeta } from "./store-meta.js";

export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * Resolve the embedded base `schema.sql` template's `__EMBEDDING_DIM__` placeholder
 * (the `vector(__EMBEDDING_DIM__)` column typemod) to a concrete dimension count.
 *
 * Use this anywhere a raw PGlite instance is bootstrapped from schema.sql — executing
 * the template verbatim makes Postgres parse the placeholder as an integer and fail with
 * `invalid input syntax for type integer: "__embedding_dim__"`.
 */
export function loadSchemaSql(dims: number = DEFAULT_EMBEDDING_DIMENSIONS): string {
  assertValidEmbeddingDimensions(dims);
  return SCHEMA_SQL.replace("__EMBEDDING_DIM__", String(dims));
}

export interface DatabaseOptions {
  embeddingDimensions?: number;
  lockLabel?: string;
}

/** Recorded when the database was embedded with a different provider/model/dims than the config asks for. */
export interface EmbeddingMismatch {
  /** Fingerprint stored in the database (provider:model:dimensions). */
  have: string;
  /** Fingerprint the current config would produce. */
  want: string;
}

/**
 * Build the actionable error thrown when an embedding operation runs against
 * a database whose stored fingerprint differs from the current config.
 */
export function embeddingMismatchError(mismatch: EmbeddingMismatch): Error {
  return new Error(
    `Embedding fingerprint mismatch: database has "${mismatch.have}" but config wants "${mismatch.want}". ` +
      "Refusing to run embedding operations against a mismatched index (mixing models silently corrupts search results).\n" +
      "Fix one of two ways:\n" +
      `  1. Revert the embedding settings in your config to match the database: provider:model:dimensions = "${mismatch.have}".\n` +
      "  2. Fully re-embed with the new model: clear the stored vectors and fingerprint —\n" +
      "       UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;\n" +
      "       DELETE FROM memkin_meta WHERE key = 'embedding_fingerprint';\n" +
      "     then reopen and run `memkin embed` to rebuild all embeddings.",
  );
}

export class Database {
  private constructor(
    readonly executor: SqlExecutor,
    readonly embeddingDimensions: number,
    private readonly embeddingMismatch: EmbeddingMismatch | null = null,
  ) {}

  /**
   * Throw if the database's embedding fingerprint diverges from the config
   * this Database was opened with. Called lazily — from EmbeddingService's
   * first-use guard — so read-only commands are never blocked by a mismatch.
   */
  assertEmbeddingConsistent(): void {
    if (this.embeddingMismatch) throw embeddingMismatchError(this.embeddingMismatch);
  }

  static async create(
    dataDirOrConfig?: string | Config,
    opts?: DatabaseOptions,
  ): Promise<Database> {
    const config: Config =
      typeof dataDirOrConfig === "string" || dataDirOrConfig === undefined
        ? ({ store: { engine: "pglite", data_dir: dataDirOrConfig } } as Config)
        : dataDirOrConfig;

    const dims = opts?.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    assertValidEmbeddingDimensions(dims);

    let executor: SqlExecutor | undefined;
    let mismatch: EmbeddingMismatch | null = null;
    try {
      executor = await createEngine(config);
      const e = executor;
      await e.bootstrap(async (conn: SqlConn) => {
        await conn.exec(loadSchemaSql(dims));
        await runMigrations(conn);
        // Self-heal SERIAL sequences left behind by id-preserving imports —
        // otherwise new-row INSERTs collide on the pkey (see sequence-sync.ts).
        const repaired = await resyncIdSequences(conn);
        if (repaired.length > 0) {
          // stderr: stdout may be an MCP stdio channel.
          console.warn(
            `[memoark] Repaired id sequence desync (likely an id-preserving import/restore): ` +
              repaired.map((r) => `${r.table} → next id ${r.maxId + 1}`).join(", "),
          );
        }
        mismatch = await ensureEmbeddingConsistency(conn, dims, config);
      });
      return new Database(e, dims, mismatch);
    } catch (err) {
      await executor?.close().catch(() => {});
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.executor.close();
  }
}

/**
 * Migrate the embedding column dimensions if they changed.
 * Clears all existing embeddings when the dimension count changes so they
 * will be re-indexed with the new model.
 */
async function migrateEmbeddingDimensions(conn: SqlConn, targetDims: number): Promise<void> {
  const result = await conn.query<{ atttypmod: number }>(
    `SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'content_chunks'::regclass
       AND attname = 'embedding'`,
  );
  if (result.rows.length === 0) return;

  // pgvector stores dimensions as atttypmod (the raw value equals the dimension count)
  const currentDims = result.rows[0].atttypmod;
  if (currentDims === targetDims) return;

  console.log(
    `[memkin] Embedding dimensions changed: ${currentDims} → ${targetDims}. ` +
      "Clearing existing embeddings for re-indexing.",
  );

  await conn.exec(`
    DROP INDEX IF EXISTS idx_chunks_embedding;
    ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${targetDims});
    UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;
    CREATE INDEX idx_chunks_embedding ON content_chunks
      USING hnsw (embedding vector_cosine_ops);
  `);
}

/**
 * Reconcile the database's stored embedding fingerprint with the current config.
 *
 * Returns the mismatch (never throws, never rewrites the stored fingerprint)
 * so read-only commands — `search --mode fts`, `export` — can still open the
 * database. Embedding paths surface the mismatch lazily on first use via
 * Database.assertEmbeddingConsistent().
 */
async function ensureEmbeddingConsistency(
  conn: SqlConn,
  targetDims: number,
  config: Config,
): Promise<EmbeddingMismatch | null> {
  const fp = {
    provider: config.embedding?.provider ?? "openai",
    model: config.embedding?.model ?? "text-embedding-3-large",
    dimensions: targetDims,
  };
  const want = fingerprintString(fp);
  const have = await readMeta(conn, "embedding_fingerprint");

  if (have === null) {
    // Fresh database — migrate dimensions if needed, then record fingerprint.
    await migrateEmbeddingDimensions(conn, targetDims);
    await writeMeta(conn, "embedding_fingerprint", want);
    return null;
  }

  if (have !== want) {
    // Do NOT silently rewrite the shared library's fingerprint, and do NOT
    // run the dimension migration (it would wipe embeddings that are still
    // valid for the recorded model). Record the divergence; embedding
    // operations will refuse to run until the user resolves it.
    return { have, want };
  }

  // Fingerprint matches — still run dimension migration guard (idempotent).
  await migrateEmbeddingDimensions(conn, targetDims);
  return null;
}

/**
 * Exported for unit-testing the fingerprint logic without requiring a
 * disk-backed PGLite instance (which would OOM in vitest fork workers).
 *
 * @internal — test use only.
 */
export async function ensureEmbeddingConsistencyForTest(
  conn: SqlConn,
  targetDims: number,
  config: Config,
): Promise<EmbeddingMismatch | null> {
  return ensureEmbeddingConsistency(conn, targetDims, config);
}
