import { describe, expect, it } from "vitest";
import { ChunkStore } from "../store/chunks.js";
import { Database } from "../store/database.js";
import type { EmbeddingService } from "../store/embedding.js";
import { GraphStore } from "../store/graph.js";
import { PageStore } from "../store/pages.js";
import { SearchEngine } from "../store/search.js";
import { TagStore } from "../store/tags.js";
import { TimelineStore } from "../store/timeline.js";
import { createApiApp, type StoreContext } from "./api.js";

async function setupAppWithChannelData() {
  const db = await Database.create(undefined, { embeddingDimensions: 768 });

  // Insert pages with various feishu channels at 2026-06-10
  const insert = async (slug: string, channel: string) => {
    const fm = JSON.stringify({
      source: {
        platform: "feishu",
        channel,
        timestamp: "2026-06-10T08:00:00Z",
      },
    });
    await db.executor.query(
      `INSERT INTO pages (slug, type, title, compiled_truth, frontmatter)
       VALUES ($1, 'task', 't', 'body', $2::jsonb)`,
      [slug, fm],
    );
  };
  await insert("p1", "group/oc_resolved");
  await insert("p2", "group/oc_failed");
  await insert("p3", "group/oc_neverseen");
  await insert("p4", "mail/INBOX");

  // identity_cache: one resolved, one failed (NULL marker)
  await db.executor.query(
    "INSERT INTO identity_cache (platform, external_id, display_name) VALUES ($1, $2, $3)",
    ["feishu:chat", "group/oc_resolved", "产品讨论"],
  );
  await db.executor.query(
    "INSERT INTO identity_cache (platform, external_id, display_name) VALUES ($1, $2, NULL)",
    ["feishu:chat", "group/oc_failed"],
  );

  // Build a real StoreContext with real stores. Embedding can be a stub.
  const pages = new PageStore(db.executor);
  const chunks = new ChunkStore(db.executor);
  const graph = new GraphStore(db.executor);
  const tags = new TagStore(db.executor);
  const timeline = new TimelineStore(db.executor);
  const embedding = {
    embedText: async () => new Float32Array(),
    embedStale: async () => ({ embedded: 0, failed: 0 }),
  } as unknown as EmbeddingService;
  const search = new SearchEngine(db.executor, {
    embedText: (q: string) => embedding.embedText(q),
  });

  const stores: StoreContext = {
    db,
    pages,
    chunks,
    search,
    graph,
    tags,
    timeline,
    embedding,
  };
  const app = createApiApp(stores);
  return { app, db };
}

interface TimelineGroup {
  key: string;
  platform: string;
  channel: string;
  count: number;
  channel_name: string | null;
  channel_name_status: "resolved" | "unresolved" | "failed" | "mail";
  signals: Array<unknown>;
}

interface TimelineFeedResponse {
  days: Array<{ date: string; groups: TimelineGroup[] }>;
  next_cursor: string | null;
}

describe("/api/timeline/feed — channel_name + channel_name_status", () => {
  it("returns resolved display_name from identity_cache for cache hits", async () => {
    const { app, db } = await setupAppWithChannelData();
    const res = await app.request("/api/timeline/feed?from=2026-06-10&to=2026-06-10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineFeedResponse;
    const groups = body.days.flatMap((d) => d.groups);
    const resolved = groups.find((g) => g.channel === "group/oc_resolved");
    expect(resolved).toBeDefined();
    expect(resolved?.channel_name).toBe("产品讨论");
    expect(resolved?.channel_name_status).toBe("resolved");
    await db.executor.close();
  });

  it("returns null display_name + status=failed when cache marker is NULL", async () => {
    const { app, db } = await setupAppWithChannelData();
    const res = await app.request("/api/timeline/feed?from=2026-06-10&to=2026-06-10");
    const body = (await res.json()) as TimelineFeedResponse;
    const groups = body.days.flatMap((d) => d.groups);
    const failed = groups.find((g) => g.channel === "group/oc_failed");
    expect(failed?.channel_name).toBeNull();
    expect(failed?.channel_name_status).toBe("failed");
    await db.executor.close();
  });

  it("returns status=unresolved when no cache row exists", async () => {
    const { app, db } = await setupAppWithChannelData();
    const res = await app.request("/api/timeline/feed?from=2026-06-10&to=2026-06-10");
    const body = (await res.json()) as TimelineFeedResponse;
    const groups = body.days.flatMap((d) => d.groups);
    const fresh = groups.find((g) => g.channel === "group/oc_neverseen");
    expect(fresh?.channel_name).toBeNull();
    expect(fresh?.channel_name_status).toBe("unresolved");
    await db.executor.close();
  });

  it("returns status=mail for mail/* channels regardless of cache", async () => {
    const { app, db } = await setupAppWithChannelData();
    const res = await app.request("/api/timeline/feed?from=2026-06-10&to=2026-06-10");
    const body = (await res.json()) as TimelineFeedResponse;
    const groups = body.days.flatMap((d) => d.groups);
    const mail = groups.find((g) => g.channel === "mail/INBOX");
    expect(mail?.channel_name_status).toBe("mail");
    await db.executor.close();
  });

  it("skips partial and missing source times instead of casting or treating ingestion as activity", async () => {
    const { app, db } = await setupAppWithChannelData();
    await db.executor.query(
      `INSERT INTO pages (slug, type, title, compiled_truth, frontmatter)
       VALUES
         ('partial-time', 'note', 'Partial', 'body',
          '{"source":{"platform":"test","channel":"partial","timestamp":"2021-04"}}'::jsonb),
         ('missing-time', 'note', 'Missing', 'body', '{}'::jsonb)`,
    );

    const res = await app.request("/api/timeline/feed?from=2026-09-01&to=2099-12-31");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineFeedResponse;
    const slugs = body.days.flatMap((day) =>
      day.groups.flatMap((group) =>
        (group.signals as Array<{ slug?: string }>).map((signal) => signal.slug),
      ),
    );
    expect(slugs).not.toContain("partial-time");
    expect(slugs).not.toContain("missing-time");
    await db.executor.close();
  });
});
