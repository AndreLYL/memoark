// src/backfill/report.ts
//
// Backfill acceptance report (task deliverable §4). Compares what the new
// SessionDistiller + apply engine produced in the isolated `staging` schema
// against the legacy `public` corpus:
//   - staging page count vs public page count
//   - per-type distribution, side by side
//   - a few sample staging (freshly distilled) pages vs legacy public pages so a
//     human can eyeball the quality lift.
//
// Read-only: queries both schemas, writes nothing.

import type { SqlExecutor } from "../store/sql-executor.js";

export interface TypeCount {
  type: string;
  count: number;
}

export interface PageSample {
  slug: string;
  type: string;
  title: string;
  authority: string | null;
  snippet: string;
}

export interface BackfillReport {
  stagingTotal: number;
  publicTotal: number;
  stagingByType: TypeCount[];
  publicByType: TypeCount[];
  stagingSamples: PageSample[];
  legacyNoiseSamples: PageSample[];
}

const SNIPPET = 240;

async function total(ex: SqlExecutor, schema: string): Promise<number> {
  const r = await ex.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${schema}.pages`);
  return r.rows[0]?.n ?? 0;
}

async function byType(ex: SqlExecutor, schema: string): Promise<TypeCount[]> {
  const r = await ex.query<{ type: string; count: number }>(
    `SELECT type, COUNT(*)::int AS count FROM ${schema}.pages GROUP BY type ORDER BY count DESC`,
  );
  return r.rows.map((row) => ({ type: row.type, count: row.count }));
}

async function samples(ex: SqlExecutor, schema: string, where: string): Promise<PageSample[]> {
  const r = await ex.query<{
    slug: string;
    type: string;
    title: string;
    authority: string | null;
    snippet: string;
  }>(
    `SELECT slug, type, title,
            frontmatter->>'authority' AS authority,
            LEFT(compiled_truth, ${SNIPPET}) AS snippet
       FROM ${schema}.pages
      ${where}
      ORDER BY id DESC
      LIMIT 5`,
  );
  return r.rows.map((row) => ({
    slug: row.slug,
    type: row.type,
    title: row.title,
    authority: row.authority,
    snippet: (row.snippet ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/** Build the staging-vs-public acceptance report. */
export async function buildBackfillReport(ex: SqlExecutor): Promise<BackfillReport> {
  const [
    stagingTotal,
    publicTotal,
    stagingByType,
    publicByType,
    stagingSamples,
    legacyNoiseSamples,
  ] = await Promise.all([
    total(ex, "staging"),
    total(ex, "public"),
    byType(ex, "staging"),
    byType(ex, "public"),
    samples(ex, "staging", ""),
    // Legacy agent-source noise for contrast: concept/decision pages are where
    // the old per-block pipeline dumped PR numbers, worktree names, etc.
    samples(ex, "public", "WHERE type IN ('concept','decision')"),
  ]);

  return {
    stagingTotal,
    publicTotal,
    stagingByType,
    publicByType,
    stagingSamples,
    legacyNoiseSamples,
  };
}

/** Render the report as human-readable text for the CLI. */
export function formatBackfillReport(rep: BackfillReport): string {
  const lines: string[] = [];
  lines.push("== Backfill acceptance report ==");
  lines.push(`staging pages (new pipeline): ${rep.stagingTotal}`);
  lines.push(`public  pages (legacy):       ${rep.publicTotal}`);
  lines.push("");
  lines.push("Type distribution (staging → public):");
  const types = new Set<string>([
    ...rep.stagingByType.map((t) => t.type),
    ...rep.publicByType.map((t) => t.type),
  ]);
  const sMap = new Map(rep.stagingByType.map((t) => [t.type, t.count]));
  const pMap = new Map(rep.publicByType.map((t) => [t.type, t.count]));
  for (const t of types) {
    lines.push(`  ${t.padEnd(14)} ${String(sMap.get(t) ?? 0).padStart(6)} → ${pMap.get(t) ?? 0}`);
  }
  lines.push("");
  lines.push("Sample staging (new) pages:");
  for (const s of rep.stagingSamples) {
    lines.push(`  [${s.type}] ${s.slug}${s.authority ? ` (${s.authority})` : ""}`);
    lines.push(`    ${s.title}`);
    if (s.snippet) lines.push(`    ${s.snippet}`);
  }
  lines.push("");
  lines.push("Sample legacy public noise pages (for contrast):");
  for (const s of rep.legacyNoiseSamples) {
    lines.push(`  [${s.type}] ${s.slug} — ${s.title}`);
  }
  return lines.join("\n");
}
