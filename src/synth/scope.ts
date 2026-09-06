import type { SourceRef } from "../core/types.js";
import type { StoreContext } from "../server/api.js";
import { latestActivitySourceExpr, safeTimestampExpr } from "../store/source-filter.js";
import type { AssembledCandidate, SynthScope } from "./types.js";

/** A retrieved candidate before ref numbering (assigned in context.assemble). */
export type RawCandidate = Omit<AssembledCandidate, "ref">;

const DEFAULT_LIMIT = 30;

function sourceToString(source: SourceRef | undefined): string | undefined {
  if (!source) return undefined;
  return source.channel_name ?? source.channel ?? source.platform ?? undefined;
}

function dedupeBySlug(candidates: RawCandidate[]): RawCandidate[] {
  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.slug}::${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Retrieve candidates for a synth scope (Spec 7 §3.3 step 3).
 * Three modes (entity / time / query); candidates are returned unnumbered —
 * ref assignment happens in context.assemble.
 */
export async function retrieve(
  scope: SynthScope,
  _opts: { poolByPage?: boolean },
  stores: StoreContext,
): Promise<RawCandidate[]> {
  const limit = scope.limit ?? DEFAULT_LIMIT;

  if (scope.query) {
    return retrieveByQuery(scope, limit, stores);
  }
  if (scope.entity) {
    return retrieveByEntity(scope, limit, stores);
  }
  if (scope.time) {
    return retrieveByTime(scope, limit, stores);
  }
  return [];
}

async function retrieveByQuery(
  scope: SynthScope,
  limit: number,
  stores: StoreContext,
): Promise<RawCandidate[]> {
  const results = await stores.search.query(scope.query as string, {
    poolByPage: true,
    type: scope.types,
    from: scope.time?.from,
    to: scope.time?.to,
    limit,
  });
  return results.map((r) => ({
    slug: r.slug,
    title: r.title,
    type: r.type,
    text: r.snippet || r.title,
    source: sourceToString(r.provenance),
  }));
}

async function retrieveByEntity(
  scope: SynthScope,
  limit: number,
  stores: StoreContext,
): Promise<RawCandidate[]> {
  const candidates: RawCandidate[] = [];
  const typeSet = scope.types && scope.types.length > 0 ? new Set(scope.types) : undefined;

  const backlinks = await stores.graph.getBacklinksEnriched(scope.entity as string);
  for (const bl of backlinks) {
    if (typeSet && !typeSet.has(bl.page.type)) continue;
    const page = await stores.pages.getPage(bl.from_slug);
    if (!page) continue;
    const source = (page.frontmatter.source ?? page.frontmatter.first_seen) as
      | SourceRef
      | undefined;
    candidates.push({
      slug: page.slug,
      title: page.title,
      type: page.type,
      text: page.compiled_truth || page.title,
      date: (source?.timestamp as string | undefined) ?? page.created_at,
      source: sourceToString(source),
    });
  }

  const timeline = await stores.timeline.getTimeline(scope.entity as string);
  for (const entry of timeline) {
    candidates.push({
      slug: scope.entity as string,
      title: entry.summary,
      type: "timeline",
      text: entry.detail ? `${entry.summary} — ${entry.detail}` : entry.summary,
      date: entry.date,
      source: sourceToString(entry.provenance),
    });
  }

  return dedupeBySlug(candidates).slice(0, limit);
}

interface TimePageRow {
  slug: string;
  title: string;
  type: string;
  compiled_truth: string;
  signal_time: string | null;
  source: SourceRef | string | null;
  source_hash: string | null;
}

/**
 * Cross-channel dedupe (Spec 9 §6): drop rows whose `frontmatter.source_hash`
 * was already seen — the same source block surfaced under two slugs (e.g. a mail
 * forwarded into a group). Rows without a source_hash are always kept. The first
 * occurrence (DESC by signal_time) wins.
 */
function dedupeBySourceHash(rows: TimePageRow[]): TimePageRow[] {
  const seenHash = new Set<string>();
  const out: TimePageRow[] = [];
  for (const row of rows) {
    if (row.source_hash) {
      if (seenHash.has(row.source_hash)) continue;
      seenHash.add(row.source_hash);
    }
    out.push(row);
  }
  return out;
}

async function retrieveByTime(
  scope: SynthScope,
  limit: number,
  stores: StoreContext,
): Promise<RawCandidate[]> {
  const time = scope.time as { from: string; to: string };
  // Time scopes describe evidence activity, not database ingestion time. Pick
  // the newest valid active contribution, with a legacy-only frontmatter fallback.
  const sourceExpr = latestActivitySourceExpr("pages.id", "pages");
  const signalTimeExpr = `(${sourceExpr}->>'timestamp')`;
  const safeSignalTime = safeTimestampExpr(signalTimeExpr);
  const params: unknown[] = [time.from, time.to];
  const conditions = [
    `${safeSignalTime} >= $1::timestamptz`,
    `${safeSignalTime} < ($2::date + interval '1 day')`,
  ];
  if (scope.types && scope.types.length > 0) {
    params.push(scope.types);
    conditions.push(`type = ANY($${params.length}::text[])`);
  }
  params.push(limit);

  const result = await stores.db.executor.query<TimePageRow>(
    `SELECT slug, title, type, compiled_truth,
       ${signalTimeExpr} AS signal_time,
       ${sourceExpr} AS source,
       frontmatter->>'source_hash' AS source_hash
     FROM pages
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${safeSignalTime} DESC
     LIMIT $${params.length}`,
    params,
  );

  return dedupeBySourceHash(result.rows).map((row) => {
    const source =
      typeof row.source === "string"
        ? (JSON.parse(row.source) as SourceRef)
        : (row.source ?? undefined);
    return {
      slug: row.slug,
      title: row.title,
      type: row.type,
      text: row.compiled_truth || row.title,
      date: row.signal_time ?? undefined,
      source: sourceToString(source ?? undefined),
    };
  });
}
