import type { MemoryFilter, SourceRef } from "../core/types.js";
import type { LLMProvider } from "../extractors/providers/types.js";
import { rewriteQuery } from "./query-rewrite.js";
import {
  latestActivitySourceExpr,
  latestActivityTimestampExpr,
  sourceFilterCondition,
} from "./source-filter.js";
import type { SqlConn } from "./sql-executor.js";
import { buildSnippet, buildTrgmConditions, splitTerms } from "./trgm-search.js";

export interface SearchResult {
  slug: string;
  title: string;
  type: string;
  snippet: string;
  score: number;
  highlights: string[];
  provenance?: SourceRef;
}

export type SearchFilterOpts = MemoryFilter & {
  /**
   * best-chunk-per-page pooling (Spec 7 §七; default flipped on in Spec 10).
   * When true (default): a page scores as its single strongest chunk (max RRF),
   * so the best evidence surfaces and many-weak-chunk pages do not inflate via accumulation.
   * When false: same-page chunks accumulate (sum) RRF scores (legacy behavior).
   * If unset, falls back to the engine's config default (`search.pool_by_page`, default true).
   * Only consulted by `query()`; `search()` ignores it.
   */
  poolByPage?: boolean;
};

interface SearchEngineOpts {
  embedText?: (text: string) => Promise<number[]>;
  /**
   * Retrieval-quality config (Spec 10). When omitted, defaults to
   * pool_by_page=true (best-chunk pooling on) and llm_rewrite=false.
   */
  search?: {
    pool_by_page?: boolean;
    llm_rewrite?: boolean;
    /** abbreviation/synonym expansion map for rule-based query rewrite. */
    synonyms?: Record<string, string[]>;
  };
  /** LLM provider; only used for query rewrite when search.llm_rewrite is true. */
  llm?: LLMProvider;
}

interface ChunkSearchRow {
  slug: string;
  title: string;
  type: string;
  snippet: string;
  chunk_source: string;
  updated_at: string | null;
  provenance: SourceRef | string | null;
}

interface CountRow {
  cnt: number | string;
}

const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
const BACKLINK_BOOST_FACTOR = 0.05;
const FRESHNESS_HALF_LIFE_DAYS = 90;
const FRESHNESS_BOOST_FACTOR = 0.3;
const TIER_WEIGHTS: Record<string, number> = { hot: 1.0, warm: 0.8, cold: 0.6 };
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

/**
 * Compute freshness multiplier using exponential decay.
 * Returns 1.0 for missing timestamps (no effect).
 * Exported for unit testing.
 */
export function freshnessMultiplier(updatedAt: string | null): number {
  if (!updatedAt) return 1.0;
  // Clamp to >=0 so future timestamps (clock skew, calendar events) cap at the boost ceiling
  // instead of producing exp(-negative) > 1 which exceeds the intended 1.3 limit.
  const ageDays = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24));
  return 1 + FRESHNESS_BOOST_FACTOR * Math.exp(-ageDays / FRESHNESS_HALF_LIFE_DAYS);
}

function clampLimit(limit: number | undefined, defaultLimit = DEFAULT_SEARCH_LIMIT): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return defaultLimit;
  return Math.min(Math.floor(limit as number), MAX_SEARCH_LIMIT);
}

function candidateLimit(limit: number): number {
  return Math.min(MAX_SEARCH_LIMIT, Math.max(DEFAULT_SEARCH_LIMIT, limit * 3));
}

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sourceField(alias: string, field: string): string {
  return `COALESCE(${alias}.frontmatter->'source'->>'${field}', ${alias}.frontmatter->'first_seen'->>'${field}')`;
}

function sourceJson(alias: string): string {
  return `COALESCE(${alias}.frontmatter->'source', ${alias}.frontmatter->'first_seen')`;
}

function addMemoryFilterConditions(
  conditions: string[],
  params: unknown[],
  opts: SearchFilterOpts | undefined,
  pageAlias = "p",
): void {
  const pageId = `${pageAlias}.id`;

  const addArrayCondition = (field: "platform" | "source_type") => {
    const values = asArray(opts?.[field]);
    if (!values || values.length === 0) return;
    params.push(values);
    const p = `$${params.length}`;
    // Spec §8: match active contributions (multi-source truth), frontmatter primary as fallback.
    conditions.push(
      sourceFilterCondition(
        pageId,
        `mc.source_ref->>'${field}' = ANY(${p}::text[])`,
        `${sourceField(pageAlias, field)} = ANY(${p}::text[])`,
      ),
    );
  };

  addArrayCondition("platform");
  addArrayCondition("source_type");

  if (opts?.channel) {
    params.push(opts.channel);
    const p = `$${params.length}`;
    conditions.push(
      sourceFilterCondition(
        pageId,
        `mc.source_ref->>'channel' = ${p}`,
        `${sourceField(pageAlias, "channel")} = ${p}`,
      ),
    );
  }

  if (opts?.channel_name) {
    params.push(opts.channel_name);
    const p = `$${params.length}`;
    conditions.push(
      sourceFilterCondition(
        pageId,
        `mc.source_ref->>'channel_name' = ${p}`,
        `${sourceField(pageAlias, "channel_name")} = ${p}`,
      ),
    );
  }

  if (opts?.participant) {
    params.push(opts.participant);
    const param = `$${params.length}`;
    const participantMatch = (json: string) => `(
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(${json}->'participants', '[]'::jsonb)) AS participant
        WHERE participant->>'name' = ${param} OR participant->>'id' = ${param}
      )
      OR ${json}->'author'->>'name' = ${param}
      OR ${json}->'author'->>'id' = ${param}
    )`;
    conditions.push(
      sourceFilterCondition(
        pageId,
        participantMatch("mc.source_ref"),
        participantMatch(sourceJson(pageAlias)),
      ),
    );
  }

  if (opts?.type && opts.type.length > 0) {
    params.push(opts.type);
    conditions.push(`${pageAlias}.type = ANY($${params.length}::text[])`);
  }

  if (opts?.exclude_types && opts.exclude_types.length > 0) {
    params.push(opts.exclude_types);
    conditions.push(`${pageAlias}.type != ALL($${params.length}::text[])`);
  }

  if (opts?.from) {
    params.push(opts.from);
    conditions.push(
      `${latestActivityTimestampExpr(pageId, pageAlias)} >= $${params.length}::timestamptz`,
    );
  }

  if (opts?.to) {
    params.push(opts.to);
    if (isDateOnly(opts.to)) {
      conditions.push(
        `${latestActivityTimestampExpr(pageId, pageAlias)} < ($${params.length}::date + interval '1 day')`,
      );
    } else {
      conditions.push(
        `${latestActivityTimestampExpr(pageId, pageAlias)} <= $${params.length}::timestamptz`,
      );
    }
  }
}

function resultSourceJson(alias: string, opts: SearchFilterOpts | undefined): string {
  return opts?.from || opts?.to
    ? latestActivitySourceExpr(`${alias}.id`, alias)
    : sourceJson(alias);
}

function parseProvenance(value: SourceRef | string | null): SourceRef | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as SourceRef;
    } catch {
      return undefined;
    }
  }
  return value;
}

export class SearchEngine {
  private embedText?: (text: string) => Promise<number[]>;
  private poolByPageDefault: boolean;
  private llmRewrite: boolean;
  private synonyms?: Record<string, string[]>;
  private llm?: LLMProvider;

  constructor(
    private pg: SqlConn,
    opts?: SearchEngineOpts,
  ) {
    this.embedText = opts?.embedText;
    // Spec 10: best-chunk pooling defaults on; config can flip it back off.
    this.poolByPageDefault = opts?.search?.pool_by_page ?? true;
    this.llmRewrite = opts?.search?.llm_rewrite ?? false;
    this.synonyms = opts?.search?.synonyms;
    this.llm = opts?.llm;
  }

  /**
   * Spec 10 §5: rule-based query rewrite (synonym expansion, stopword filter,
   * whitespace normalize) before retrieval; optional LLM rewrite only when
   * search.llm_rewrite is true AND a provider is configured. Recall-only.
   */
  private async rewrite(query: string): Promise<string> {
    if (this.llmRewrite && this.llm) {
      return rewriteQuery(query, {
        synonyms: this.synonyms,
        llm: { enabled: true, provider: this.llm },
      });
    }
    return rewriteQuery(query, { synonyms: this.synonyms });
  }

  async search(query: string, opts?: SearchFilterOpts): Promise<SearchResult[]> {
    const limit = clampLimit(opts?.limit);
    const terms = splitTerms(query);
    if (terms.length === 0) return [];

    const params: unknown[] = [query.trim()]; // $1: similarity() ranking input
    const trgm = buildTrgmConditions(terms, ["p.title", "p.compiled_truth"], params);
    if (!trgm) return [];
    const conditions: string[] = [trgm];
    addMemoryFilterConditions(conditions, params, opts, "p");
    params.push(limit);

    const result = await this.pg.query<{
      slug: string;
      title: string;
      type: string;
      page_rank: number | string;
      body: string;
      provenance: SourceRef | string | null;
    }>(
      `SELECT
         p.slug,
         p.title,
         p.type,
         GREATEST(similarity(p.title, $1), similarity(p.compiled_truth, $1)) AS page_rank,
         p.compiled_truth AS body,
         ${resultSourceJson("p", opts)} AS provenance
       FROM pages p
       WHERE ${conditions.join(" AND ")}
       ORDER BY page_rank DESC, p.updated_at DESC, p.slug ASC
       LIMIT $${params.length}`,
      params,
    );

    return result.rows.map((row) => {
      const snippet = buildSnippet(row.body, terms);
      return {
        slug: row.slug,
        title: row.title,
        type: row.type,
        snippet,
        score: Number(row.page_rank),
        highlights: snippet ? [snippet] : [],
        provenance: parseProvenance(row.provenance),
      };
    });
  }

  async query(query: string, opts?: SearchFilterOpts): Promise<SearchResult[]> {
    const limit = clampLimit(opts?.limit);
    // Spec 10: per-call opt overrides config default (which itself defaults to true).
    const poolByPage = opts?.poolByPage ?? this.poolByPageDefault;
    // Spec 10 §5: rewrite for recall (rule-based; optional LLM). Falls back to the
    // original query if rewriting produces nothing usable.
    const effectiveQuery = (await this.rewrite(query)) || query;
    const [ftsResults, vectorResults] = await Promise.all([
      this.ftsChunkSearch(effectiveQuery, opts, candidateLimit(limit)),
      this.vectorSearch(effectiveQuery, opts, candidateLimit(limit)),
    ]);

    const scoreMap = new Map<
      string,
      {
        slug: string;
        title: string;
        type: string;
        snippet: string;
        score: number;
        chunk_source: string;
        updated_at: string | null;
        provenance?: SourceRef;
      }
    >();

    const addRanked = (
      results: Array<{
        slug: string;
        title: string;
        type: string;
        snippet: string;
        chunk_source: string;
        updated_at: string | null;
        provenance: SourceRef | string | null;
      }>,
    ) => {
      for (let rank = 0; rank < results.length; rank++) {
        const r = results[rank];
        const rrfScore = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(r.slug);
        // best-chunk pooling: max of strongest single chunk; default: accumulate (sum).
        const newScore = poolByPage
          ? Math.max(existing?.score ?? 0, rrfScore)
          : (existing?.score ?? 0) + rrfScore;
        if (!existing || newScore > existing.score) {
          scoreMap.set(r.slug, {
            slug: r.slug,
            title: r.title,
            type: r.type,
            snippet: existing?.snippet || r.snippet,
            score: newScore,
            chunk_source: r.chunk_source,
            updated_at: r.updated_at,
            provenance: parseProvenance(r.provenance),
          });
        } else {
          existing.score = newScore;
        }
      }
    };

    addRanked(ftsResults);
    addRanked(vectorResults);

    for (const entry of scoreMap.values()) {
      if (entry.chunk_source === "compiled_truth") {
        entry.score *= COMPILED_TRUTH_BOOST;
      }
    }

    // Tier weighting: batch-fetch tier for all scored slugs in one query
    const slugs = [...scoreMap.keys()];
    if (slugs.length > 0) {
      const tierRows = await this.pg.query<{ slug: string; tier: string }>(
        `SELECT slug, tier FROM pages WHERE slug = ANY($1::text[])`,
        [slugs],
      );
      const tierMap = new Map(tierRows.rows.map((r) => [r.slug, r.tier]));
      for (const entry of scoreMap.values()) {
        const tier = tierMap.get(entry.slug) ?? "hot";
        entry.score *= TIER_WEIGHTS[tier] ?? 1.0;
      }
    }
    if (slugs.length > 0) {
      for (const slug of slugs) {
        const bl = await this.pg.query<CountRow>(
          `SELECT COUNT(*) AS cnt FROM links l JOIN pages p ON p.id = l.to_page_id WHERE p.slug = $1`,
          [slug],
        );
        const backlinkCount = Number(bl.rows[0]?.cnt ?? 0);
        if (backlinkCount > 0) {
          const entry = scoreMap.get(slug);
          if (entry) {
            entry.score *= 1 + BACKLINK_BOOST_FACTOR * Math.log(1 + backlinkCount);
          }
        }
      }
    }

    // Apply freshness boost
    for (const entry of scoreMap.values()) {
      entry.score *= freshnessMultiplier(entry.updated_at);
    }

    let results = [...scoreMap.values()].sort((a, b) => b.score - a.score);

    // Post-filter by type and exclude_types
    if (opts?.type && opts.type.length > 0) {
      const typeSet = new Set(opts.type);
      results = results.filter((r) => typeSet.has(r.type));
    }

    if (opts?.exclude_types && opts.exclude_types.length > 0) {
      const excludeSet = new Set(opts.exclude_types);
      results = results.filter((r) => !excludeSet.has(r.type));
    }

    return results.slice(0, limit).map(({ chunk_source: _, updated_at: __, snippet, ...rest }) => ({
      ...rest,
      snippet,
      highlights: snippet ? [snippet] : [],
    }));
  }

  private async ftsChunkSearch(
    query: string,
    opts?: SearchFilterOpts,
    limit = MAX_SEARCH_LIMIT,
  ): Promise<
    Array<{
      slug: string;
      title: string;
      type: string;
      snippet: string;
      chunk_source: string;
      updated_at: string | null;
      provenance: SourceRef | string | null;
    }>
  > {
    const terms = splitTerms(query);
    if (terms.length === 0) return [];

    const params: unknown[] = [query.trim()]; // $1: similarity() ranking input
    const trgm = buildTrgmConditions(terms, ["cc.chunk_text"], params);
    if (!trgm) return [];
    const conditions = [trgm];
    addMemoryFilterConditions(conditions, params, opts, "p");
    params.push(limit);

    const result = await this.pg.query<{
      slug: string;
      title: string;
      type: string;
      chunk_source: string;
      updated_at: string | null;
      chunk_text: string;
      provenance: SourceRef | string | null;
    }>(
      `SELECT p.slug, p.title, p.type, cc.chunk_source, p.updated_at,
         similarity(cc.chunk_text, $1) AS chunk_rank,
         cc.chunk_text AS chunk_text,
         ${resultSourceJson("p", opts)} AS provenance
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY chunk_rank DESC, p.updated_at DESC NULLS LAST, p.slug ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      type: r.type,
      snippet: buildSnippet(r.chunk_text, terms),
      chunk_source: r.chunk_source,
      updated_at: r.updated_at,
      provenance: r.provenance,
    }));
  }

  private async vectorSearch(
    query: string,
    opts?: SearchFilterOpts,
    limit = MAX_SEARCH_LIMIT,
  ): Promise<
    Array<{
      slug: string;
      title: string;
      type: string;
      snippet: string;
      chunk_source: string;
      updated_at: string | null;
      provenance: SourceRef | string | null;
    }>
  > {
    if (!this.embedText) return [];
    const queryVec = await this.embedText(query);
    const vecStr = `[${queryVec.join(",")}]`;
    const conditions = ["cc.embedding IS NOT NULL"];
    const params: unknown[] = [vecStr];
    addMemoryFilterConditions(conditions, params, opts, "p");
    params.push(limit);
    const result = await this.pg.query<ChunkSearchRow>(
      `SELECT p.slug, p.title, p.type, cc.chunk_source, p.updated_at,
         cc.chunk_text AS snippet, 1 - (cc.embedding <=> $1::vector) AS cosine_sim,
         ${resultSourceJson("p", opts)} AS provenance
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY cc.embedding <=> $1::vector LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }
}
