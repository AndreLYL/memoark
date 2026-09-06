import { resolve } from "node:path";
import { Hono } from "hono";
import type { ChunkStore } from "../store/chunks.js";
import type { Database } from "../store/database.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { GraphStore } from "../store/graph.js";
import type { PageStore } from "../store/pages.js";
import type { SearchEngine } from "../store/search.js";
import { latestActivitySourceExpr, latestActivityTimestampExpr } from "../store/source-filter.js";
import type { TagStore } from "../store/tags.js";
import type { TimelineStore } from "../store/timeline.js";
import { createDefaultBackfillRoutes } from "./backfill-routes.js";
import type { ChatNameRefreshJob } from "./chat-name-refresh-job.js";
import { registerChatNameRoutes } from "./chat-name-routes.js";
import { createConfigRoutes } from "./config-routes.js";
import type { EventBus } from "./event-bus.js";
import { extractBearerToken, tokensMatch } from "./server-security.js";

export interface DaemonStatus {
  running: boolean;
  uptime_seconds: number | null;
  last_run: string | null;
  next_scheduled: string | null;
}

export interface StoreContext {
  db: Database;
  pages: PageStore;
  chunks: ChunkStore;
  search: SearchEngine;
  graph: GraphStore;
  tags: TagStore;
  timeline: TimelineStore;
  embedding: EmbeddingService;
  getDaemonStatus?: () => DaemonStatus | undefined;
  eventBus?: EventBus;
  runExtract?: (source?: string) => Promise<{ written: number; skipped: number; errors: number }>;
  chatNameRefreshJob?: ChatNameRefreshJob;
}

function missing(c: { json: (body: unknown, status?: number) => Response }, name: string) {
  return c.json({ error: `Missing required parameter: ${name}` }, 400);
}

export interface ApiAppOpts {
  /** Fired after a successful config save (triggers async hot-reload). Not awaited. */
  onConfigSaved?: () => void;
  /**
   * When set, every `/api/*` route requires `Authorization: Bearer <token>`.
   * When unset (loopback-only default), no auth is enforced and the local UX is
   * unchanged. Web UI static assets are served OUTSIDE this Hono app (in the
   * Bun.serve fetch closure) and stay unauthenticated — they are the app shell,
   * not data; auth protects the data-bearing `/api/*` routes.
   */
  authToken?: string;
}

export function createApiApp(stores: StoreContext, apiOpts: ApiAppOpts = {}): Hono {
  const app = new Hono();

  // Bearer-token guard for all data-bearing routes. Every route in this app
  // (config, backfill, chat-name, data) resolves under /api/*, so a single
  // prefix guard covers them all. No token configured → no auth (loopback UX).
  if (apiOpts.authToken) {
    const expected = apiOpts.authToken;
    app.use("/api/*", async (c, next) => {
      const presented = extractBearerToken({ header: (name) => c.req.header(name) });
      if (!tokensMatch(expected, presented)) {
        return c.json({ error: "Unauthorized: valid bearer token required" }, 401);
      }
      return next();
    });
  }

  const configRoutes = createConfigRoutes({
    configPath: resolve(process.cwd(), "memkin.yaml"),
    onConfigSaved: apiOpts.onConfigSaved,
  });
  app.route("/", configRoutes);

  const backfillRoutes = createDefaultBackfillRoutes(stores, resolve(process.cwd(), "memkin.yaml"));
  app.route("/", backfillRoutes);

  // Data routes (health, pages, search, graph, etc.) are mounted under /api
  // so the front-end client (web/src/api/client.ts, BASE="/api") can reach them.
  const dataRoutes = new Hono();

  dataRoutes.get("/health", async (c) => {
    const pages = await stores.db.executor.query("SELECT COUNT(*) AS c FROM pages");
    const chunks = await stores.db.executor.query("SELECT COUNT(*) AS c FROM content_chunks");

    const sourcesResult = await stores.db.executor.query(`
      SELECT
        COALESCE(frontmatter->>'platform', 'unknown') AS platform,
        COUNT(*)::int AS signals_total,
        MAX(
          COALESCE(
            frontmatter->'source'->>'timestamp',
            frontmatter->'first_seen'->>'timestamp'
          )
        ) AS last_sync
      FROM pages
      WHERE frontmatter->>'platform' IS NOT NULL
      GROUP BY platform
    `);

    const sources = (
      sourcesResult.rows as Array<{
        platform: string;
        signals_total: number;
        last_sync: string | null;
      }>
    ).map((row) => ({
      name: row.platform,
      platform: row.platform,
      status: row.last_sync ? ("healthy" as const) : ("never_run" as const),
      last_sync: row.last_sync,
      last_error: null,
      signals_total: row.signals_total,
    }));

    const daemon: DaemonStatus = stores.getDaemonStatus?.() ?? {
      running: false,
      uptime_seconds: null,
      last_run: null,
      next_scheduled: null,
    };

    return c.json({
      status: "ok",
      pages: Number((pages.rows[0] as Record<string, unknown>).c),
      chunks: Number((chunks.rows[0] as Record<string, unknown>).c),
      daemon,
      sources,
    });
  });

  dataRoutes.get("/pages", async (c) => {
    const limitRaw = c.req.query("limit");
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      limit = Number.isFinite(n) && n >= 0 ? n : undefined;
    }

    const excludeTypesRaw = c.req.query("exclude_types");
    const exclude_types = excludeTypesRaw ? excludeTypesRaw.split(",") : undefined;

    return c.json(
      await stores.pages.listPages({
        type: c.req.query("type"),
        exclude_types,
        limit,
        sort: c.req.query("sort"),
        order: c.req.query("order"),
      }),
    );
  });
  dataRoutes.get("/pages/by-slug", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) return missing(c, "slug");
    const page = await stores.pages.getPage(slug);
    if (!page) return c.json({ error: "Not found" }, 404);

    const includeRaw = c.req.query("include");
    if (!includeRaw) return c.json(page);

    const includes = new Set(includeRaw.split(","));
    const response: Record<string, unknown> = { ...page };

    if (includes.has("links")) {
      response.links = await stores.graph.getLinksEnriched(slug);
    }
    if (includes.has("backlinks")) {
      response.backlinks = await stores.graph.getBacklinksEnriched(slug);
    }
    if (includes.has("timeline")) {
      response.timeline = await stores.timeline.getTimeline(slug);
    }

    return c.json(response);
  });
  dataRoutes.put("/pages/by-slug", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) return missing(c, "slug");
    const body = await c.req.json<{ content?: string }>();
    if (!body.content) return missing(c, "content");
    const page = await stores.pages.putPage(slug, body.content);
    await stores.chunks.rechunk(page.id, page.compiled_truth);
    return c.json(page);
  });
  dataRoutes.delete("/pages/by-slug", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) return missing(c, "slug");
    await stores.pages.deletePage(slug);
    return c.json({ ok: true });
  });

  dataRoutes.get("/search", async (c) => {
    const typeParam = c.req.query("type");
    const excludeTypesParam = c.req.query("exclude_types");
    return c.json(
      await stores.search.search(c.req.query("q") ?? "", {
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        type: typeParam ? typeParam.split(",") : undefined,
        exclude_types: excludeTypesParam ? excludeTypesParam.split(",") : undefined,
        from: c.req.query("from") ?? undefined,
        to: c.req.query("to") ?? undefined,
        platform: c.req.query("platform") ?? undefined,
      }),
    );
  });
  dataRoutes.post("/query", async (c) => {
    const body = await c.req.json<{
      query?: string;
      limit?: number;
      type?: string;
      from?: string;
      to?: string;
      platform?: string;
      exclude_types?: string;
    }>();
    return c.json(
      await stores.search.query(body.query ?? "", {
        limit: body.limit,
        type: body.type ? body.type.split(",") : undefined,
        exclude_types: body.exclude_types ? body.exclude_types.split(",") : undefined,
        from: body.from,
        to: body.to,
        platform: body.platform,
      }),
    );
  });

  dataRoutes.get("/stats", async (c) => {
    const pagesResult = await stores.db.executor.query(
      "SELECT type, COUNT(*)::int AS count FROM pages GROUP BY type",
    );
    const chunksResult = await stores.db.executor.query(
      "SELECT COUNT(*)::int AS total, COUNT(embedded_at)::int AS embedded FROM content_chunks",
    );
    const linksResult = await stores.db.executor.query("SELECT COUNT(*)::int AS c FROM links");

    const pages_by_type: Record<string, number> = {};
    let totalPages = 0;
    for (const row of pagesResult.rows as Array<{ type: string; count: number }>) {
      pages_by_type[row.type] = row.count;
      totalPages += row.count;
    }

    const chunkRow = chunksResult.rows[0] as { total: number; embedded: number };
    const linkRow = linksResult.rows[0] as { c: number };

    return c.json({
      pages: totalPages,
      chunks: chunkRow.total,
      embedded_chunks: chunkRow.embedded,
      links: linkRow.c,
      pages_by_type,
    });
  });

  dataRoutes.get("/links/all", async (c) => {
    const result = await stores.db.executor.query(
      `SELECT pf.slug AS from_slug, pt.slug AS to_slug, l.link_type, l.context
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
       JOIN pages pt ON pt.id = l.to_page_id`,
    );
    return c.json(result.rows);
  });

  dataRoutes.get("/links", async (c) =>
    c.json(await stores.graph.getLinks(c.req.query("slug") ?? "")),
  );
  dataRoutes.get("/backlinks", async (c) =>
    c.json(await stores.graph.getBacklinks(c.req.query("slug") ?? "")),
  );
  dataRoutes.post("/links", async (c) => {
    const body = await c.req.json<{ from: string; to: string; type?: string; context?: string }>();
    await stores.graph.addLink(body.from, body.to, body.type ?? "", body.context);
    return c.json({ ok: true });
  });
  dataRoutes.delete("/links", async (c) => {
    const body = await c.req.json<{ from: string; to: string }>();
    await stores.graph.removeLink(body.from, body.to);
    return c.json({ ok: true });
  });
  dataRoutes.get("/graph/traverse", async (c) =>
    c.json(
      await stores.graph.traverse(c.req.query("slug") ?? "", {
        depth: c.req.query("depth") ? Number(c.req.query("depth")) : undefined,
        direction: (c.req.query("direction") as "in" | "out" | "both" | undefined) ?? "out",
      }),
    ),
  );

  dataRoutes.get("/tags", async (c) =>
    c.json(await stores.tags.getTags(c.req.query("slug") ?? "")),
  );
  dataRoutes.post("/tags", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) return missing(c, "slug");
    const body = await c.req.json<{ tag?: string }>();
    if (!body.tag) return missing(c, "tag");
    await stores.tags.addTag(slug, body.tag);
    return c.json({ ok: true });
  });
  dataRoutes.delete("/tags", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) return missing(c, "slug");
    const body = await c.req.json<{ tag?: string }>();
    if (!body.tag) return missing(c, "tag");
    await stores.tags.removeTag(slug, body.tag);
    return c.json({ ok: true });
  });

  dataRoutes.get("/timeline", async (c) =>
    c.json(await stores.timeline.getTimeline(c.req.query("slug") ?? "")),
  );
  dataRoutes.post("/timeline", async (c) => {
    const slug = c.req.query("slug");
    if (!slug) return missing(c, "slug");
    await stores.timeline.addEntry(slug, await c.req.json());
    return c.json({ ok: true });
  });
  dataRoutes.get("/timeline/feed", async (c) => {
    const fromParam = c.req.query("from");
    const toParam = c.req.query("to");
    const groupBy = c.req.query("group_by") === "type" ? "type" : "channel";
    const typeParam = c.req.query("type");
    const platformParam = c.req.query("platform");
    const excludeTypesParam = c.req.query("exclude_types");
    const cursor = c.req.query("cursor");
    const limitDays = Math.min(Number(c.req.query("limit")) || 7, 31);

    // The feed pages BACKWARDS in time: the cursor is the newest day (inclusive
    // upper bound) of the requested page, and next_cursor points at the first
    // active day older than the current page. Day volume is bounded by an
    // active-day LIMIT in SQL, so no lower bound is needed while paginating.
    const to = cursor ?? toParam ?? new Date().toISOString().slice(0, 10);
    const activitySource = latestActivitySourceExpr("pages.id", "pages");
    const activityTimestamp = latestActivityTimestampExpr("pages.id", "pages");
    const activityTimestampText = `(${activitySource}->>'timestamp')`;

    const params: unknown[] = [to];
    const conditions: string[] = [
      `${activityTimestamp} IS NOT NULL`,
      // Upper bound on the calendar day, compared as a UTC date-string prefix so
      // the filter matches how days are grouped (`LEFT(signal_time, 10)`) and how
      // the cursor is emitted. Casting `$1::date + interval` to timestamptz would
      // resolve midnight in the *session* timezone (PGlite inherits the process
      // TZ), silently dropping "today"'s signals for any east-of-UTC deployment.
      `LEFT(${activityTimestampText}, 10) <= $1`,
    ];
    if (fromParam) {
      params.push(fromParam);
      conditions.push(`${activityTimestamp} >= $${params.length}::timestamptz`);
    }

    if (typeParam) {
      const types = typeParam.split(",");
      params.push(types);
      conditions.push(`type = ANY($${params.length}::text[])`);
    }
    if (excludeTypesParam) {
      const excludeTypes = excludeTypesParam.split(",");
      params.push(excludeTypes);
      conditions.push(`type != ALL($${params.length}::text[])`);
    }
    if (platformParam) {
      params.push(platformParam);
      conditions.push(`${activitySource}->>'platform' = $${params.length}`);
    }

    const sql = `
  WITH page_signals AS (
    SELECT slug, type, title,
           LEFT(compiled_truth, 200) AS snippet,
           ${activityTimestampText} AS signal_time,
           COALESCE(
             ${activitySource}->>'platform',
             'manual'
           ) AS platform,
           COALESCE(
             ${activitySource}->>'channel',
             '—'
           ) AS channel
    FROM pages
    WHERE ${conditions.join(" AND ")}
  ),
  active_days AS (
    SELECT DISTINCT LEFT(signal_time, 10) AS day
    FROM page_signals
    ORDER BY day DESC
    LIMIT ${limitDays + 1}
  )
  SELECT ps.*,
         ic.display_name AS channel_name,
         CASE
           WHEN ps.channel LIKE 'mail/%' THEN 'mail'
           WHEN ic.display_name IS NOT NULL THEN 'resolved'
           WHEN ic.resolved_at IS NOT NULL THEN 'failed'
           ELSE 'unresolved'
         END AS channel_name_status
  FROM page_signals ps
  JOIN active_days ad ON LEFT(ps.signal_time, 10) = ad.day
  LEFT JOIN identity_cache ic
    ON ic.platform = 'feishu:chat' AND ic.external_id = ps.channel
  ORDER BY ps.signal_time DESC
`;

    const result = await stores.db.executor.query(sql, params);
    const rows = result.rows as Array<{
      slug: string;
      type: string;
      title: string;
      snippet: string;
      signal_time: string;
      platform: string;
      channel: string;
      channel_name: string | null;
      channel_name_status: "resolved" | "unresolved" | "failed" | "mail";
    }>;

    // Group by day, then by channel or type
    const dayMap = new Map<string, Map<string, typeof rows>>();
    for (const row of rows) {
      const day = row.signal_time.slice(0, 10);
      if (!dayMap.has(day)) dayMap.set(day, new Map());
      const groupKey =
        groupBy === "type" ? row.type : `${row.channel_name || row.channel} (${row.platform})`;
      const groups = dayMap.get(day)!;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey)!.push(row);
    }

    const sortedDays = [...dayMap.keys()].sort((a, b) => b.localeCompare(a));
    const pagedDays = sortedDays.slice(0, limitDays);
    const nextCursor = sortedDays.length > limitDays ? sortedDays[limitDays] : null;

    const days = pagedDays.map((date) => {
      const groups = dayMap.get(date)!;
      return {
        date,
        groups: [...groups.entries()].map(([key, signals]) => ({
          key,
          platform: signals[0].platform,
          channel: signals[0].channel,
          channel_name: signals[0].channel_name,
          channel_name_status: signals[0].channel_name_status,
          count: signals.length,
          signals: signals.map((s) => ({
            slug: s.slug,
            type: s.type,
            title: s.title,
            snippet: s.snippet,
            date: s.signal_time,
            platform: s.platform,
            channel: s.channel,
            channel_name: s.channel_name,
            channel_name_status: s.channel_name_status,
          })),
        })),
      };
    });

    return c.json({ days, next_cursor: nextCursor });
  });
  dataRoutes.get("/chunks", async (c) =>
    c.json(await stores.chunks.getChunks(c.req.query("slug") ?? "")),
  );
  dataRoutes.post("/embed", async (c) =>
    c.json(
      await stores.embedding.embedStale({
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      }),
    ),
  );

  let runningPipeline: string | null = null;

  dataRoutes.post("/extract", async (c) => {
    if (!stores.runExtract) {
      return c.json({ error: "Extract not configured" }, 501);
    }
    const body = await c.req.json<{ source?: string }>().catch(() => ({}));
    const source = (body as { source?: string }).source ?? "all";

    if (runningPipeline) {
      return c.json({ error: "Pipeline already running", source: runningPipeline }, 409);
    }

    runningPipeline = source;

    if (stores.eventBus) {
      stores.eventBus.emit("pipeline:start", {
        platform: source,
        timestamp: new Date().toISOString(),
      });
    }

    stores
      .runExtract(source === "all" ? undefined : source)
      .then((stats) => {
        if (stores.eventBus) {
          stores.eventBus.emit("pipeline:end", {
            platform: source,
            stats,
            timestamp: new Date().toISOString(),
          });
        }
      })
      .catch((err) => {
        if (stores.eventBus) {
          stores.eventBus.emit("pipeline:error", {
            platform: source,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          });
        }
      })
      .finally(() => {
        runningPipeline = null;
      });

    return c.json({ started: true, source });
  });

  dataRoutes.get("/events", async (c) => {
    if (!stores.eventBus) {
      return c.json({ error: "SSE not available" }, 501);
    }

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const onSignalNew = (data: unknown) => send("signal:new", data);
        const onPipelineStart = (data: unknown) => send("pipeline:start", data);
        const onPipelineEnd = (data: unknown) => send("pipeline:end", data);
        const onPipelineError = (data: unknown) => send("pipeline:error", data);

        stores.eventBus!.on("signal:new", onSignalNew);
        stores.eventBus!.on("pipeline:start", onPipelineStart);
        stores.eventBus!.on("pipeline:end", onPipelineEnd);
        stores.eventBus!.on("pipeline:error", onPipelineError);

        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 30000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          stores.eventBus!.off("signal:new", onSignalNew);
          stores.eventBus!.off("pipeline:start", onPipelineStart);
          stores.eventBus!.off("pipeline:end", onPipelineEnd);
          stores.eventBus!.off("pipeline:error", onPipelineError);
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  dataRoutes.get("/provenance", async (c) => {
    const channel = c.req.query("channel");
    const from = c.req.query("from");
    const to = c.req.query("to");

    const signals: Array<{ type: string; slug?: string; summary: string; source: unknown }> = [];

    // Query pages with source in frontmatter
    const pagesResult = await stores.db.executor.query(
      `SELECT slug, frontmatter FROM pages
       WHERE frontmatter->'source' IS NOT NULL
       ${channel ? "AND frontmatter->'source'->>'channel' = $1" : ""}
       ORDER BY frontmatter->'source'->>'timestamp' DESC`,
      channel ? [channel] : [],
    );
    for (const row of pagesResult.rows as Array<{
      slug: string;
      frontmatter: Record<string, unknown>;
    }>) {
      const src = row.frontmatter.source as Record<string, unknown> | undefined;
      if (!src) continue;
      const ts = src.timestamp as string | undefined;
      if (from && ts && ts < from) continue;
      if (to && ts && ts > to) continue;
      signals.push({
        type: (row.frontmatter.type as string) ?? "page",
        slug: row.slug,
        summary: (row.frontmatter.title as string) ?? row.slug,
        source: src,
      });
    }

    // Query timeline entries with provenance
    const timelineResult = await stores.db.executor.query(
      `SELECT te.summary, te.date, te.provenance, p.slug
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
       WHERE te.provenance IS NOT NULL
       ${channel ? "AND te.provenance->>'channel' = $1" : ""}
       ORDER BY te.date DESC`,
      channel ? [channel] : [],
    );
    for (const row of timelineResult.rows as Array<{
      summary: string;
      date: string;
      provenance: unknown;
      slug: string;
    }>) {
      const prov = row.provenance as Record<string, unknown>;
      const ts = prov.timestamp as string | undefined;
      if (from && ts && ts < from) continue;
      if (to && ts && ts > to) continue;
      signals.push({ type: "timeline", slug: row.slug, summary: row.summary, source: prov });
    }

    // Query links with provenance
    const linksResult = await stores.db.executor.query(
      `SELECT pf.slug AS from_slug, pt.slug AS to_slug, l.link_type, l.provenance
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
       JOIN pages pt ON pt.id = l.to_page_id
       WHERE l.provenance IS NOT NULL
       ${channel ? "AND l.provenance->>'channel' = $1" : ""}`,
      channel ? [channel] : [],
    );
    for (const row of linksResult.rows as Array<{
      from_slug: string;
      to_slug: string;
      link_type: string;
      provenance: unknown;
    }>) {
      const prov = row.provenance as Record<string, unknown>;
      const ts = prov.timestamp as string | undefined;
      if (from && ts && ts < from) continue;
      if (to && ts && ts > to) continue;
      signals.push({
        type: "link",
        summary: `${row.from_slug} → ${row.to_slug} (${row.link_type})`,
        source: prov,
      });
    }

    // Sort by timestamp
    signals.sort((a, b) => {
      const tsA = ((a.source as Record<string, unknown>)?.timestamp as string) ?? "";
      const tsB = ((b.source as Record<string, unknown>)?.timestamp as string) ?? "";
      return tsB.localeCompare(tsA);
    });

    return c.json(signals);
  });

  // Chat-name resolution endpoints (refresh + status)
  registerChatNameRoutes(app, stores);

  app.route("/api", dataRoutes);

  return app;
}
