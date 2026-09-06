// src/store/source-filter.ts
//
// Source filtering against active contributions (spec §8, PR-4).
//
// The multi-source truth lives in memory_contributions, not in the frontmatter
// (which keeps only a singular `source` = primary, for display). Filtering by a
// NON-primary platform / source_type / channel would MISS multi-source pages if
// it read only the frontmatter primary. So every source filter now matches
// against the page's ACTIVE contributions.
//
// Legacy pages that predate the apply engine have no contributions yet; for
// them we fall back to the frontmatter primary so existing retrieval keeps
// working during the transition. Concretely, a page matches a source filter
// when EITHER an active contribution matches, OR (the page has no active
// contributions AND) the frontmatter primary matches.

/**
 * Build a boolean SQL condition that matches when an active contribution of the
 * page satisfies `contribCond`, or — only when the page has no active
 * contributions — the frontmatter `fallbackCond` matches.
 *
 * `contribCond` is evaluated against alias `mc` (memory_contributions);
 * `fallbackCond` against whatever page/entry aliases the caller already uses.
 * Both branches must reference the SAME bound parameter so the caller pushes it
 * exactly once.
 */
export function sourceFilterCondition(
  pageIdExpr: string,
  contribCond: string,
  fallbackCond: string,
): string {
  const base = `SELECT 1 FROM memory_contributions mc WHERE mc.canonical_page_id = ${pageIdExpr} AND mc.active`;
  return `(EXISTS (${base} AND (${contribCond})) OR (NOT EXISTS (${base}) AND (${fallbackCond})))`;
}

/**
 * A correlated subquery returning the primary active contribution's source_ref
 * (first user_confirmed, else earliest) as JSONB, for use in COALESCE(...) so
 * derived timestamps/sources come from contributions with a frontmatter
 * fallback. Alias-safe: pass the page id expression.
 */
export function primaryContribSourceExpr(pageIdExpr: string): string {
  return `(
    SELECT mc.source_ref FROM memory_contributions mc
     WHERE mc.canonical_page_id = ${pageIdExpr} AND mc.active
     ORDER BY (mc.authority = 'user_confirmed') DESC, mc.created_at ASC
     LIMIT 1
  )`;
}

/**
 * Cast free-form historical text only when PostgreSQL can prove it is a complete,
 * valid timestamp. Both supported local engines run PostgreSQL 17 semantics.
 * Partial dates such as `2021-04` deliberately remain unknown for exact windows.
 */
export function safeTimestampExpr(textExpr: string): string {
  // PostgreSQL intentionally accepts convenient inputs such as `now`, `today`,
  // `infinity`, and locale-shaped dates. Those are unsafe for persisted evidence:
  // an old fuzzy value could otherwise become the current day at query time.
  const exactIsoShape =
    `(${textExpr}) ~ ` +
    `'^[0-9]{4}-(0[1-9]|1[0-2])-([0][1-9]|[12][0-9]|3[01])$|` +
    `^[0-9]{4}-(0[1-9]|1[0-2])-([0][1-9]|[12][0-9]|3[01])T` +
    `([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?` +
    `(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'`;
  return `(CASE
    WHEN ${exactIsoShape} AND pg_input_is_valid(${textExpr}, 'timestamptz')
      THEN (${textExpr})::timestamptz
    ELSE NULL
  END)`;
}

function validLegacySourceExpr(pageAlias: string): string {
  const source = `${pageAlias}.frontmatter->'source'`;
  const firstSeen = `${pageAlias}.frontmatter->'first_seen'`;
  return `(CASE
    WHEN ${safeTimestampExpr(`${source}->>'timestamp'`)} IS NOT NULL THEN ${source}
    WHEN ${safeTimestampExpr(`${firstSeen}->>'timestamp'`)} IS NOT NULL THEN ${firstSeen}
    ELSE NULL
  END)`;
}

/**
 * Return the source carrying a page's latest valid evidence/activity timestamp.
 *
 * Active contributions are authoritative for v2 pages. The frontmatter fallback
 * is used only by legacy pages with no active contributions; if contributions
 * exist but all their timestamps are unknown, the result stays unknown rather
 * than borrowing an ingestion/materialization timestamp.
 */
export function latestActivitySourceExpr(pageIdExpr: string, pageAlias: string): string {
  const active = `SELECT 1 FROM memory_contributions mc WHERE mc.canonical_page_id = ${pageIdExpr} AND mc.active`;
  const validTimestamp = safeTimestampExpr("mc.source_ref->>'timestamp'");
  return `(CASE
    WHEN EXISTS (${active}) THEN (
      SELECT mc.source_ref
      FROM memory_contributions mc
      WHERE mc.canonical_page_id = ${pageIdExpr}
        AND mc.active
        AND ${validTimestamp} IS NOT NULL
      ORDER BY ${validTimestamp} DESC, mc.created_at DESC
      LIMIT 1
    )
    ELSE ${validLegacySourceExpr(pageAlias)}
  END)`;
}

/** Latest exact source/evidence time for date-window filtering. */
export function latestActivityTimestampExpr(pageIdExpr: string, pageAlias: string): string {
  return safeTimestampExpr(`(${latestActivitySourceExpr(pageIdExpr, pageAlias)})->>'timestamp'`);
}
