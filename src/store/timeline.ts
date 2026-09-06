import { compactSourceRef } from "../core/source-ref.js";
import type { MemoryFilter, SourceRef } from "../core/types.js";
import { safeTimestampExpr, sourceFilterCondition } from "./source-filter.js";
import type { SqlConn } from "./sql-executor.js";

export interface TimelineEntry {
  id: number;
  page_id: number;
  date: string;
  summary: string;
  detail: string;
  source: string;
  provenance?: SourceRef;
  created_at: string;
}

export interface TimelineFeedEntry {
  slug: string;
  title: string;
  type: string;
  summary: string;
  snippet: string;
  time: string;
  provenance?: SourceRef;
}

interface TimelineFeedRow {
  slug: string;
  title: string;
  type: string;
  summary: string;
  snippet: string;
  time: string;
  provenance: SourceRef | string | null;
}

type TimelineRow = Omit<TimelineEntry, "provenance"> & {
  provenance?: SourceRef | string | null;
};

interface InsertRow {
  id: number;
}

const DEFAULT_TIMELINE_LIMIT = 20;
const MAX_TIMELINE_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return DEFAULT_TIMELINE_LIMIT;
  return Math.min(Math.floor(limit as number), MAX_TIMELINE_LIMIT);
}

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function sourceJson(): string {
  return `COALESCE(te.provenance, p.frontmatter->'source', p.frontmatter->'first_seen')`;
}

function sourceField(field: string): string {
  return `COALESCE(te.provenance->>'${field}', p.frontmatter->'source'->>'${field}', p.frontmatter->'first_seen'->>'${field}')`;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
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

function addFeedFilters(
  conditions: string[],
  params: unknown[],
  opts?: MemoryFilter & { query?: string },
): void {
  if (opts?.query) {
    params.push(`%${opts.query}%`);
    conditions.push(
      `(te.summary ILIKE $${params.length} OR te.detail ILIKE $${params.length} OR p.title ILIKE $${params.length})`,
    );
  }

  const pageId = "p.id";

  const addArrayCondition = (field: "platform" | "source_type") => {
    const values = asArray(opts?.[field]);
    if (!values || values.length === 0) return;
    params.push(values);
    const p = `$${params.length}`;
    // Spec §8: match active contributions, timeline-entry/frontmatter primary as fallback.
    conditions.push(
      sourceFilterCondition(
        pageId,
        `mc.source_ref->>'${field}' = ANY(${p}::text[])`,
        `${sourceField(field)} = ANY(${p}::text[])`,
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
        `${sourceField("channel")} = ${p}`,
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
        `${sourceField("channel_name")} = ${p}`,
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
        participantMatch(sourceJson()),
      ),
    );
  }

  if (opts?.type && opts.type.length > 0) {
    params.push(opts.type);
    conditions.push(`p.type = ANY($${params.length}::text[])`);
  }

  if (opts?.exclude_types && opts.exclude_types.length > 0) {
    params.push(opts.exclude_types);
    conditions.push(`p.type != ALL($${params.length}::text[])`);
  }

  if (opts?.from) {
    params.push(opts.from);
    conditions.push(`${safeTimestampExpr("te.date")} >= $${params.length}::timestamptz`);
  }

  if (opts?.to) {
    params.push(opts.to);
    if (isDateOnly(opts.to)) {
      conditions.push(
        `${safeTimestampExpr("te.date")} < ($${params.length}::date + interval '1 day')`,
      );
    } else {
      conditions.push(`${safeTimestampExpr("te.date")} <= $${params.length}::timestamptz`);
    }
  }
}

export class TimelineStore {
  constructor(private pg: SqlConn) {}

  async addEntry(
    pageSlug: string,
    entry: {
      date: string;
      summary: string;
      detail?: string;
      source?: string;
      provenance?: SourceRef;
    },
  ): Promise<void> {
    const result = await this.pg.query<InsertRow>(
      `INSERT INTO timeline_entries (page_id, date, summary, detail, source, provenance)
       SELECT id, $2, $3, $4, $5, $6 FROM pages WHERE slug = $1
       ON CONFLICT (page_id, date, summary) DO UPDATE SET
         detail = EXCLUDED.detail,
         source = EXCLUDED.source,
         provenance = COALESCE(EXCLUDED.provenance, timeline_entries.provenance)
       RETURNING id`,
      [
        pageSlug,
        entry.date,
        entry.summary,
        entry.detail ?? "",
        entry.source ?? "",
        entry.provenance ? JSON.stringify(compactSourceRef(entry.provenance)) : null,
      ],
    );
    if (result.rows.length === 0) {
      throw new Error(`Page not found: ${pageSlug}`);
    }
  }

  async getTimeline(pageSlug: string): Promise<TimelineEntry[]> {
    const result = await this.pg.query<TimelineRow>(
      `SELECT te.* FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
       WHERE p.slug = $1
       ORDER BY te.date DESC`,
      [pageSlug],
    );
    return result.rows.map((row) => ({
      ...row,
      provenance: parseProvenance(row.provenance ?? null),
    }));
  }

  async feed(opts?: MemoryFilter & { query?: string }): Promise<TimelineFeedEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    addFeedFilters(conditions, params, opts);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limit = clampLimit(opts?.limit);
    params.push(limit);

    const result = await this.pg.query<TimelineFeedRow>(
      `SELECT
         p.slug,
         p.title,
         p.type,
         te.summary,
         COALESCE(NULLIF(te.detail, ''), LEFT(p.compiled_truth, 200)) AS snippet,
         te.date AS time,
         ${sourceJson()} AS provenance
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
       ${whereClause}
       ORDER BY te.date DESC, te.created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    return result.rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      type: row.type,
      summary: row.summary,
      snippet: row.snippet,
      time: row.time,
      provenance: parseProvenance(row.provenance),
    }));
  }

  async getAllTimelineGrouped(): Promise<Map<string, TimelineEntry[]>> {
    const result = await this.pg.query<TimelineEntry & { slug: string }>(
      `SELECT te.*, p.slug AS slug FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
       ORDER BY p.slug, te.date DESC`,
    );
    const grouped = new Map<string, TimelineEntry[]>();
    for (const row of result.rows) {
      const { slug, ...entry } = row;
      const list = grouped.get(slug);
      if (list) list.push(entry as TimelineEntry);
      else grouped.set(slug, [entry as TimelineEntry]);
    }
    return grouped;
  }
}
