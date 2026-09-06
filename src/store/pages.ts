import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { SourceRef } from "../core/types.js";
import { rechunkTx } from "./chunks.js";
import { GraphStore } from "./graph.js";
import { latestActivitySourceExpr, latestActivityTimestampExpr } from "./source-filter.js";
import type { SqlConn, SqlExecutor } from "./sql-executor.js";
import { parseWikiLinks } from "./wikilink.js";

export interface Page {
  id: number;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  content_hash: string;
  halflife_days: number | null;
  tier: string;
  expires_at: string | null;
  consolidated_into: number | null;
  created_at: string;
  updated_at: string;
  /** Exact source/evidence time, populated by signal-time listings. */
  activity_time?: string | null;
}

export interface PutPageOptions {
  halflife_days?: number | null;
  expires_at?: Date | null; // explicit override; null clears it; undefined = auto-compute from halflife_days
  // Spec 10: auto-wire [[wikilinks]] from compiled_truth into typed edges. Default true.
  // Set false for callers that manage their own [[...]] semantics (e.g. Obsidian sync,
  // which creates "obsidian"-typed links and must not be shadowed by generic "mentions").
  autoWikilink?: boolean;
}

interface ParsedContent {
  title: string;
  type: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
}

interface PageRow {
  id: number;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown> | string;
  content_hash: string;
  halflife_days: number | null;
  tier: string;
  // Timestamp columns arrive as Date from PGLite/pg drivers, or as strings
  // from drivers/configs that skip type parsing. rowToPage normalizes both
  // to ISO strings per the Page contract.
  expires_at: string | Date | null;
  consolidated_into: number | null;
  created_at: string | Date;
  updated_at: string | Date;
  activity_time?: string | Date | null;
}

/**
 * Normalize a driver timestamp value (Date from PGLite/pg, or already a
 * string) to the ISO-8601 string the Page interface declares. Without this,
 * Date objects leak through rowToPage and break consumers that rely on the
 * declared string type (e.g. MCP `put_page` output schema validation).
 */
function toIsoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseMarkdownWithFrontmatter(content: string): ParsedContent {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { title: "", type: "unknown", compiled_truth: content.trim(), frontmatter: {} };
  }
  const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
  const body = fmMatch[2].trim();
  const title = String(fm.title ?? "");
  const type = String(fm.type ?? "unknown");

  const { title: _t, type: _ty, ...rest } = fm;

  return { title, type, compiled_truth: body, frontmatter: rest };
}

export class PageStore {
  private graph: GraphStore;

  constructor(private pg: SqlConn) {
    this.graph = new GraphStore(pg);
  }

  async putPage(slug: string, content: string, opts?: PutPageOptions): Promise<Page> {
    const { title, type, compiled_truth, frontmatter } = parseMarkdownWithFrontmatter(content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const halflifeDays = opts?.halflife_days ?? null;

    // Compute expires_at in TS to correctly handle the three-way distinction:
    // - explicit Date: use that value
    // - explicit null: store NULL (clear it)
    // - undefined: auto-compute from halflife_days, or NULL if halflife_days is null
    let expiresAt: Date | null;
    if (opts?.expires_at !== undefined) {
      expiresAt = opts.expires_at; // Date or null, both stored as-is
    } else if (halflifeDays !== null) {
      expiresAt = new Date(Date.now() + halflifeDays * 86_400_000);
    } else {
      expiresAt = null;
    }

    const result = await this.pg.query<PageRow>(
      `INSERT INTO pages (slug, type, title, compiled_truth, frontmatter, content_hash, halflife_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (slug) DO UPDATE SET
         type = EXCLUDED.type,
         title = EXCLUDED.title,
         compiled_truth = EXCLUDED.compiled_truth,
         frontmatter = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         halflife_days = EXCLUDED.halflife_days,
         updated_at = NOW()
       RETURNING *`,
      [
        slug,
        type,
        title,
        compiled_truth,
        JSON.stringify(frontmatter),
        contentHash,
        halflifeDays,
        expiresAt,
      ],
    );
    const page = this.rowToPage(result.rows[0]);

    // Spec 10 §4: zero-LLM auto-wiring. Scan ONLY compiled_truth for wikilinks
    // and create typed edges. Missing targets are skipped (addLink no-ops when a
    // slug is absent); this never throws and never breaks the write.
    // Skippable (autoWikilink:false) for callers that own [[...]] semantics (Obsidian sync).
    if (opts?.autoWikilink !== false) {
      await this.wireWikiLinks(slug, compiled_truth);
    }

    return page;
  }

  /**
   * Atomically write a page and re-chunk its content in a single transaction.
   * Prevents mixed state where page-from-A is paired with chunks-from-B under
   * concurrent same-slug writes.
   *
   * The transaction:
   * 1. INSERT pages(slug) ON CONFLICT DO NOTHING  — ensure row exists
   * 2. SELECT id FROM pages WHERE slug=$1 FOR UPDATE  — lock the page row
   * 3. putPageTx — upsert page columns
   * 4. rechunkTx — upsert + delete stale chunks
   *
   * Wikilink wiring is best-effort and runs AFTER the transaction (never
   * breaks the write; missing targets are skipped).
   */
  async putPageWithChunks(
    ex: SqlExecutor,
    slug: string,
    content: string,
    opts?: PutPageOptions,
  ): Promise<Page> {
    const parsed = parseMarkdownWithFrontmatter(content);
    let page!: Page;

    await ex.transaction(async (tx) => {
      // Ensure the page row exists before locking it.
      await tx.query(
        "INSERT INTO pages (slug, type, title, compiled_truth, frontmatter) VALUES ($1, 'unknown', '', '', '{}') ON CONFLICT (slug) DO NOTHING",
        [slug],
      );
      // Lock the row to prevent concurrent slug writes from mixing.
      const locked = await tx.query<{ id: number }>(
        "SELECT id FROM pages WHERE slug = $1 FOR UPDATE",
        [slug],
      );
      if (locked.rows.length === 0) return; // shouldn't happen

      page = await this.putPageTx(tx, slug, content, opts);
      await rechunkTx(tx, page.id, parsed.compiled_truth);
    });

    // Wikilink wiring is best-effort, outside the transaction.
    if (opts?.autoWikilink !== false) {
      await this.wireWikiLinks(slug, parsed.compiled_truth);
    }

    return page;
  }

  /**
   * Execute the putPage upsert SQL within the provided connection (or
   * transaction). Does NOT wire wikilinks (caller's responsibility).
   */
  private async putPageTx(
    conn: SqlConn,
    slug: string,
    content: string,
    opts?: PutPageOptions,
  ): Promise<Page> {
    const { title, type, compiled_truth, frontmatter } = parseMarkdownWithFrontmatter(content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const halflifeDays = opts?.halflife_days ?? null;

    let expiresAt: Date | null;
    if (opts?.expires_at !== undefined) {
      expiresAt = opts.expires_at;
    } else if (halflifeDays !== null) {
      expiresAt = new Date(Date.now() + halflifeDays * 86_400_000);
    } else {
      expiresAt = null;
    }

    const result = await conn.query<PageRow>(
      `INSERT INTO pages (slug, type, title, compiled_truth, frontmatter, content_hash, halflife_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (slug) DO UPDATE SET
         type = EXCLUDED.type,
         title = EXCLUDED.title,
         compiled_truth = EXCLUDED.compiled_truth,
         frontmatter = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         halflife_days = EXCLUDED.halflife_days,
         updated_at = NOW()
       RETURNING *`,
      [
        slug,
        type,
        title,
        compiled_truth,
        JSON.stringify(frontmatter),
        contentHash,
        halflifeDays,
        expiresAt,
      ],
    );
    return this.rowToPage(result.rows[0]);
  }

  private async wireWikiLinks(fromSlug: string, compiledTruth: string): Promise<void> {
    const links = parseWikiLinks(compiledTruth);
    if (links.length === 0) return;
    const provenance = { auto: "wikilink" } as unknown as SourceRef;
    for (const link of links) {
      if (link.to === fromSlug) continue; // never self-link
      try {
        await this.graph.addLink(fromSlug, link.to, link.type, "", provenance);
      } catch {
        // Target slug missing (or any transient edge error) -> skip, never break the write.
      }
    }
  }

  async getPage(slug: string): Promise<Page | null> {
    const result = await this.pg.query<PageRow>("SELECT * FROM pages WHERE slug = $1", [slug]);
    return result.rows.length > 0 ? this.rowToPage(result.rows[0]) : null;
  }

  /**
   * Merge a synth cache entry into frontmatter.synth[intent] WITHOUT bumping
   * updated_at or re-chunking. Returns false if the page does not exist.
   *
   * Atomic: merges via jsonb || operator on the server — eliminates the
   * lost-update race between getPage → mutate JS → UPDATE. Uses nested ||
   * instead of jsonb_set with a 2-element path to work around a PGLite bug
   * where jsonb_set ignores sub-path navigation (returns {} for depth > 1).
   * Both PGLite and PG17 support the || operator correctly.
   */
  async setSynthCache(slug: string, intent: string, entry: unknown): Promise<boolean> {
    const result = await this.pg.query<{ id: number }>(
      `UPDATE pages
       SET frontmatter = COALESCE(frontmatter, '{}')::jsonb ||
           jsonb_build_object($2::text,
             COALESCE(frontmatter->'synth', '{}')::jsonb ||
             jsonb_build_object($3::text, $4::jsonb))
       WHERE slug = $1
       RETURNING id`,
      [slug, "synth", intent, JSON.stringify(entry)],
    );
    return result.rows.length > 0;
  }

  /**
   * Merge top-level keys into a page's frontmatter WITHOUT bumping updated_at
   * or re-chunking. Returns false if the page does not exist.
   *
   * Atomic: uses the jsonb || merge operator on the server — eliminates the
   * lost-update race between getPage → mutate JS → UPDATE.
   */
  async patchFrontmatter(slug: string, patch: Record<string, unknown>): Promise<boolean> {
    const result = await this.pg.query<{ id: number }>(
      `UPDATE pages
       SET frontmatter = COALESCE(frontmatter, '{}')::jsonb || $2::jsonb
       WHERE slug = $1
       RETURNING id`,
      [slug, JSON.stringify(patch)],
    );
    return result.rows.length > 0;
  }

  async deletePage(slug: string): Promise<void> {
    await this.pg.query("DELETE FROM pages WHERE slug = $1", [slug]);
  }

  async listPages(opts?: {
    type?: string;
    exclude_types?: string[];
    limit?: number;
    sort?: string;
    order?: string;
    /** Inclusive source/evidence lower bound; valid only with sort=signal_time. */
    source_from?: string;
  }): Promise<Page[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (opts?.type) {
      conditions.push(`type = $${params.length + 1}`);
      params.push(opts.type);
    }
    if (opts?.exclude_types && opts.exclude_types.length > 0) {
      conditions.push(`type != ALL($${params.length + 1}::text[])`);
      params.push(opts.exclude_types);
    }
    if (opts?.source_from) {
      if (opts.sort !== "signal_time") {
        throw new Error("source_from requires sort=signal_time");
      }
      params.push(opts.source_from);
      conditions.push(
        `${latestActivityTimestampExpr("pages.id", "pages")} >= $${params.length}::timestamptz`,
      );
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const sortDir = opts?.order === "asc" ? "ASC" : "DESC";

    let sql: string;
    if (opts?.sort === "backlinks") {
      sql = `SELECT p.* FROM pages p
        LEFT JOIN (
          SELECT to_page_id, COUNT(*) AS cnt FROM links GROUP BY to_page_id
        ) lc ON lc.to_page_id = p.id${whereClause}
        ORDER BY COALESCE(lc.cnt, 0) ${sortDir}`;
    } else if (opts?.sort === "signal_time") {
      const activitySource = latestActivitySourceExpr("pages.id", "pages");
      const activityTime = latestActivityTimestampExpr("pages.id", "pages");
      sql = `SELECT *, (${activitySource}->>'timestamp') AS activity_time FROM pages${whereClause}
        ORDER BY ${activityTime} ${sortDir} NULLS LAST`;
    } else {
      const sortCol = ["updated_at", "created_at", "title"].includes(opts?.sort ?? "")
        ? (opts?.sort ?? "updated_at")
        : "updated_at";
      sql = `SELECT * FROM pages${whereClause} ORDER BY ${sortCol} ${sortDir}`;
    }

    if (opts?.limit) {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(opts.limit);
    }

    const result = await this.pg.query<PageRow>(sql, params);
    return result.rows.map((r) => this.rowToPage(r));
  }

  async listExpiredHot(): Promise<Page[]> {
    const result = await this.pg.query<PageRow>(
      `SELECT * FROM pages
       WHERE tier = 'hot'
         AND expires_at IS NOT NULL
         AND expires_at < NOW()
       ORDER BY expires_at`,
    );
    return result.rows.map((r) => this.rowToPage(r));
  }

  async updatePageTier(id: number, tier: string, consolidatedInto?: number | null): Promise<void> {
    if (consolidatedInto !== undefined) {
      await this.pg.query(
        `UPDATE pages SET tier = $1, consolidated_into = $2, updated_at = NOW() WHERE id = $3`,
        [tier, consolidatedInto, id],
      );
    } else {
      await this.pg.query(`UPDATE pages SET tier = $1, updated_at = NOW() WHERE id = $2`, [
        tier,
        id,
      ]);
    }
  }

  async listPagesByTier(tier: string): Promise<Page[]> {
    const result = await this.pg.query<PageRow>(
      `SELECT * FROM pages WHERE tier = $1 ORDER BY created_at`,
      [tier],
    );
    return result.rows.map((r) => this.rowToPage(r));
  }

  private rowToPage(row: PageRow): Page {
    return {
      id: row.id,
      slug: row.slug,
      type: row.type,
      title: row.title,
      compiled_truth: row.compiled_truth,
      frontmatter:
        typeof row.frontmatter === "string" ? JSON.parse(row.frontmatter) : row.frontmatter,
      content_hash: row.content_hash,
      halflife_days: row.halflife_days,
      tier: row.tier ?? "hot",
      expires_at: row.expires_at == null ? null : toIsoTimestamp(row.expires_at),
      consolidated_into: row.consolidated_into ?? null,
      created_at: toIsoTimestamp(row.created_at),
      updated_at: toIsoTimestamp(row.updated_at),
      ...(row.activity_time !== undefined
        ? {
            activity_time: row.activity_time == null ? null : toIsoTimestamp(row.activity_time),
          }
        : {}),
    };
  }
}
