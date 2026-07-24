import { afterEach, describe, expect, it } from "vitest";
import { Database } from "../../src/store/database.js";

describe("Database.create overload + executor", () => {
  it("legacy undefined arg works (pglite in-memory)", async () => {
    const db = await Database.create(undefined);
    expect(db.executor).toBeDefined();
    expect(typeof db.executor.query).toBe("function");
    await db.close();
  });
  it("config arg selects engine", async () => {
    const db = await Database.create({ store: { engine: "pglite" } } as any);
    await db.close();
  });

  it("rejects embedding dimensions above the pgvector HNSW limit before bootstrap", async () => {
    await expect(Database.create(undefined, { embeddingDimensions: 2001 })).rejects.toThrow(
      "Embedding dimensions cannot exceed 2000. pgvector HNSW indexes support at most 2000 dimensions. For OpenAI text-embedding-3-large, use 1536. Got: 2001.",
    );
  });
});

describe("Database", () => {
  let db: Database;

  afterEach(async () => {
    if (db) await db.close();
  });

  it("creates in-memory database with all tables", async () => {
    db = await Database.create();

    const tables = await db.executor.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const names = tables.rows.map((r) => r.tablename);
    expect(names).toContain("pages");
    expect(names).toContain("content_chunks");
    expect(names).toContain("links");
    expect(names).toContain("tags");
    expect(names).toContain("timeline_entries");
  });

  it("has pgvector extension loaded", async () => {
    db = await Database.create();
    const ext = await db.executor.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(ext.rows).toHaveLength(1);
  });

  it("has pg_trgm extension and GIN indexes installed (search_vector + triggers dropped in migration 006)", async () => {
    db = await Database.create();

    // Migration 006 dropped the tsvector search_vector column and its triggers;
    // full-text search now uses pg_trgm GIN indexes via ILIKE.
    const ext = await db.executor.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'",
    );
    expect(ext.rows).toHaveLength(1);

    const idx = await db.executor.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'pages'
         AND indexname IN ('idx_pages_title_trgm', 'idx_pages_compiled_truth_trgm')
       ORDER BY indexname`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      "idx_pages_compiled_truth_trgm",
      "idx_pages_title_trgm",
    ]);
  });
});
