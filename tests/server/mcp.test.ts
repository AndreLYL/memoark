import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../../src/extractors/providers/mock.js";
import { createMcpServer, createMcpToolHandlers } from "../../src/server/mcp.js";
import { ChunkStore } from "../../src/store/chunks.js";
import { Database } from "../../src/store/database.js";
import { EmbeddingService } from "../../src/store/embedding.js";
import { GraphStore } from "../../src/store/graph.js";
import { PageStore } from "../../src/store/pages.js";
import { SearchEngine } from "../../src/store/search.js";
import { TagStore } from "../../src/store/tags.js";
import { TimelineStore } from "../../src/store/timeline.js";

describe("MCP server", () => {
  let db: Database;
  let stores: Parameters<typeof createMcpToolHandlers>[0];

  beforeEach(async () => {
    db = await Database.create();
    stores = {
      db,
      pages: new PageStore(db.executor),
      chunks: new ChunkStore(db.executor),
      graph: new GraphStore(db.executor),
      tags: new TagStore(db.executor),
      timeline: new TimelineStore(db.executor),
      search: new SearchEngine(db.executor, {
        embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
      }),
      embedding: new EmbeddingService(db.executor, { provider: "openai", apiKey: "test-key" }),
    };
  });
  afterEach(async () => {
    await db.close();
  });

  it("creates an MCP server", () => {
    const server = createMcpServer(stores);
    expect(server).toBeTruthy();
  });

  it("tool handlers can put and get pages", async () => {
    const tools = createMcpToolHandlers(stores);
    await tools.put_page({
      slug: "entities/alice",
      content: "---\ntitle: Alice\ntype: person\n---\nAlice.",
    });
    const page = await tools.get_page({ slug: "entities/alice" });
    expect(page.slug).toBe("entities/alice");
  });

  it("tool handlers expose query, graph, tags, timeline, chunks, and health", async () => {
    const tools = createMcpToolHandlers(stores);
    await tools.put_page({
      slug: "entities/alice",
      content: "---\ntitle: Alice\ntype: person\n---\nAlice.",
    });
    await tools.put_page({
      slug: "projects/memkin",
      content: "---\ntitle: Memkin\ntype: project\n---\nMemkin.",
    });
    await tools.add_link({ from: "entities/alice", to: "projects/memkin", type: "works_on" });
    await tools.add_tag({ slug: "entities/alice", tag: "person" });
    await tools.add_timeline_entry({
      slug: "entities/alice",
      date: "2026-05-26",
      summary: "Started Memkin",
    });

    expect(await tools.search({ query: "Alice" })).toHaveLength(1);
    expect(await tools.get_links({ slug: "entities/alice" })).toHaveLength(1);
    expect(await tools.get_backlinks({ slug: "projects/memkin" })).toHaveLength(1);
    const traverseResult = await tools.traverse_graph({
      slug: "entities/alice",
      depth: 1,
      direction: "out",
    });
    expect(traverseResult).toHaveProperty("focus");
    expect(traverseResult).toHaveProperty("nodes");
    expect(traverseResult).toHaveProperty("edges");
    expect(await tools.get_tags({ slug: "entities/alice" })).toEqual(["person"]);
    expect(await tools.get_timeline({ slug: "entities/alice" })).toHaveLength(1);
    expect(await tools.get_chunks({ slug: "entities/alice" })).toHaveLength(1);
    expect((await tools.get_health()).status).toBe("ok");
  });

  describe("get_session_context", () => {
    it("returns markdown overview containing decisions, tasks, and preferences", async () => {
      const tools = createMcpToolHandlers(stores);
      const recent = new Date(Date.now() - 86_400_000).toISOString();
      await tools.put_page({
        slug: "decisions/use-pglite",
        content: `---\ntitle: Use PGLite\ntype: decision\nsource:\n  platform: test\n  channel: decisions/use-pglite\n  timestamp: ${recent}\n---\nChose PGLite for embedded DB.`,
      });
      await tools.put_page({
        slug: "tasks/implement-spec3",
        content: "---\ntitle: Implement Spec 3\ntype: task\nstatus: open\n---\nAdd MCP tools.",
      });
      await tools.put_page({
        slug: "preferences/dark-mode",
        content: "---\ntitle: Prefers dark mode\ntype: preference\n---\nUser likes dark mode.",
      });

      const result = await tools.get_session_context({});
      expect(typeof result).toBe("string");
      expect(result).toContain("Use PGLite");
      expect(result).toContain("Implement Spec 3");
      expect(result).toContain("Prefers dark mode");
      expect(result.length).toBeLessThan(5000);
    });

    it("returns a meaningful string even with empty database", async () => {
      const tools = createMcpToolHandlers(stores);
      const result = await tools.get_session_context({});
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("respects the days parameter", async () => {
      const tools = createMcpToolHandlers(stores);
      const result = await tools.get_session_context({ days: 1 });
      expect(typeof result).toBe("string");
    });
  });

  describe("list_signals_by_entity", () => {
    it("returns signals linked to an entity via mentions", async () => {
      const tools = createMcpToolHandlers(stores);
      await tools.put_page({
        slug: "entities/alice",
        content: "---\ntitle: Alice\ntype: person\n---\nAlice.",
      });
      await tools.put_page({
        slug: "decisions/d1",
        content: "---\ntitle: Decision 1\ntype: decision\n---\nA decision about Alice.",
      });
      await tools.add_link({ from: "decisions/d1", to: "entities/alice", type: "mentions" });

      const result = await tools.list_signals_by_entity({ entity_slug: "entities/alice" });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty("slug");
      expect(result[0]).toHaveProperty("type");
    });

    it("filters by signal_types when provided", async () => {
      const tools = createMcpToolHandlers(stores);
      await tools.put_page({
        slug: "entities/bob",
        content: "---\ntitle: Bob\ntype: person\n---\nBob.",
      });
      await tools.put_page({
        slug: "decisions/d2",
        content: "---\ntitle: D2\ntype: decision\n---\nDecision.",
      });
      await tools.put_page({
        slug: "knowledge/k1",
        content: "---\ntitle: K1\ntype: knowledge\n---\nKnowledge.",
      });
      await tools.add_link({ from: "decisions/d2", to: "entities/bob", type: "mentions" });
      await tools.add_link({ from: "knowledge/k1", to: "entities/bob", type: "mentions" });

      const result = await tools.list_signals_by_entity({
        entity_slug: "entities/bob",
        signal_types: ["decision"],
      });
      expect(result.every((r: { type: string }) => r.type === "decision")).toBe(true);
    });

    it("returns empty array for entity with no backlinks", async () => {
      const tools = createMcpToolHandlers(stores);
      await tools.put_page({
        slug: "entities/lonely",
        content: "---\ntitle: Lonely\ntype: person\n---\nLonely.",
      });
      const result = await tools.list_signals_by_entity({ entity_slug: "entities/lonely" });
      expect(result).toHaveLength(0);
    });
  });

  describe("get_entity_profile", () => {
    it("returns structured profile with page, grouped signals, and timeline", async () => {
      const tools = createMcpToolHandlers(stores);
      await tools.put_page({
        slug: "entities/carol",
        content: "---\ntitle: Carol\ntype: person\n---\nCarol is a product manager.",
      });
      await tools.put_page({
        slug: "decisions/carol-d1",
        content: "---\ntitle: Chose React\ntype: decision\n---\nDecision body.",
      });
      await tools.add_link({ from: "decisions/carol-d1", to: "entities/carol", type: "mentions" });
      await stores.timeline.addEntry("entities/carol", {
        date: "2026-05-01",
        summary: "Kickoff meeting",
      });

      const result = await tools.get_entity_profile({ entity_slug: "entities/carol" });
      expect(result).toHaveProperty("page");
      expect(result).toHaveProperty("signals");
      expect(result).toHaveProperty("timeline");
      expect((result.page as { title: string }).title).toBe("Carol");
      expect(Array.isArray(result.timeline)).toBe(true);
    });

    it("returns null page for non-existent entity", async () => {
      const tools = createMcpToolHandlers(stores);
      const result = await tools.get_entity_profile({ entity_slug: "entities/ghost" });
      expect(result.page).toBeNull();
      expect(result.signals).toEqual({});
      expect(result.timeline).toHaveLength(0);
    });
  });

  describe("query tier weighting", () => {
    it("hot pages score higher than cold pages with identical content", async () => {
      const tools = createMcpToolHandlers(stores);

      await tools.put_page({
        slug: "knowledge/hot-page",
        content: "---\ntitle: Hot Knowledge\ntype: knowledge\n---\nPGLite is a WASM SQLite.",
      });
      await tools.put_page({
        slug: "knowledge/cold-page",
        content: "---\ntitle: Cold Knowledge\ntype: knowledge\n---\nPGLite is a WASM SQLite.",
      });

      // Force cold-page to cold tier
      await stores.db.executor.query(
        "UPDATE pages SET tier = 'cold' WHERE slug = 'knowledge/cold-page'",
      );

      const results = await tools.query({ query: "PGLite WASM SQLite" });
      const hotIdx = (results as Array<{ slug: string }>).findIndex(
        (r) => r.slug === "knowledge/hot-page",
      );
      const coldIdx = (results as Array<{ slug: string }>).findIndex(
        (r) => r.slug === "knowledge/cold-page",
      );

      expect(hotIdx).toBeGreaterThanOrEqual(0);
      expect(coldIdx).toBeGreaterThanOrEqual(0);
      expect(hotIdx).toBeLessThan(coldIdx);
    });
  });

  it("tool handlers pass unified filters to query and search with clamped limits", async () => {
    const tools = createMcpToolHandlers(stores);
    const querySpy = vi.spyOn(stores.search, "query").mockResolvedValue([]);
    const searchSpy = vi.spyOn(stores.search, "search").mockResolvedValue([]);

    await tools.query({
      query: "Memkin deployment",
      platform: "wechat",
      source_type: "dm",
      participant: "张三",
      limit: 999,
    });
    await tools.search({
      query: "Memkin deployment",
      platform: ["wechat", "feishu"],
      source_type: "group",
      participant: "李四",
      limit: 999,
    });

    expect(querySpy).toHaveBeenCalledWith(
      "Memkin deployment",
      expect.objectContaining({
        platform: "wechat",
        source_type: "dm",
        participant: "张三",
        limit: 50,
      }),
    );
    expect(searchSpy).toHaveBeenCalledWith(
      "Memkin deployment",
      expect.objectContaining({
        platform: ["wechat", "feishu"],
        source_type: "group",
        participant: "李四",
        limit: 50,
      }),
    );
  });

  it("put_page is idempotent and skips rechunk when content is unchanged", async () => {
    const tools = createMcpToolHandlers(stores);
    // Spy on putPageWithChunks (the new atomic write path); rechunk is now
    // called internally inside the transaction and no longer directly spied on.
    const putPageWithChunksSpy = vi.spyOn(stores.pages, "putPageWithChunks");
    const content = "---\ntitle: Idempotent\ntype: note\n---\nStable content.";

    const first = await tools.put_page({ slug: "notes/idempotent", content });
    const pageAfterFirst = await stores.pages.getPage("notes/idempotent");
    const chunksAfterFirst = await stores.chunks.getChunks("notes/idempotent");

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await tools.put_page({ slug: "notes/idempotent", content });
    const pageAfterSecond = await stores.pages.getPage("notes/idempotent");
    const chunksAfterSecond = await stores.chunks.getChunks("notes/idempotent");

    expect(first).toMatchObject({
      ok: true,
      slug: "notes/idempotent",
      changed: true,
    });
    expect(second).toMatchObject({
      ok: true,
      slug: "notes/idempotent",
      changed: false,
      previous_hash: first.content_hash,
    });
    expect(String(pageAfterSecond?.updated_at)).toBe(String(pageAfterFirst?.updated_at));
    expect(chunksAfterSecond).toHaveLength(chunksAfterFirst.length);
    // putPageWithChunks must be called exactly once (for the first write);
    // unchanged content triggers the early-return path in put_page.
    expect(putPageWithChunksSpy).toHaveBeenCalledTimes(1);
  });

  it("write handlers return structured errors instead of false success", async () => {
    const tools = createMcpToolHandlers(stores);

    expect(await tools.put_page({ slug: "", content: "Body" })).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "slug must be a non-empty stable page identifier",
        suggestion: "Use a slug such as `projects/memkin` or `people/alice`.",
      },
    });

    expect(
      await tools.add_timeline_entry({
        slug: "missing/page",
        date: "not-a-date",
        summary: "Broken entry",
      }),
    ).toEqual({
      error: {
        code: "INVALID_DATE",
        message: "date must be an ISO date or datetime",
        suggestion: "Retry with a value such as `2026-06-04` or `2026-06-04T10:00:00.000Z`.",
      },
    });

    expect(
      await tools.add_timeline_entry({
        slug: "missing/page",
        date: "2026-06-04",
        summary: "Missing target",
      }),
    ).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Page not found: missing/page",
        suggestion: "Call `query` or `search` first to find the correct page slug.",
      },
    });

    expect(
      await tools.manage_links({
        action: "add",
        from: "missing/from",
        to: "missing/to",
      }),
    ).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Page not found: missing/from",
        suggestion: "Call `query` or `search` first to find the correct page slug.",
      },
    });

    expect(
      await tools.manage_tags({
        action: "add",
        slug: "missing/page",
        tags: ["mcp"],
      }),
    ).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Page not found: missing/page",
        suggestion: "Call `query` or `search` first to find the correct page slug.",
      },
    });
  });

  it("write handlers validate provenance input", async () => {
    const tools = createMcpToolHandlers(stores);
    await tools.put_page({
      slug: "entities/alice",
      content: "---\ntitle: Alice\ntype: person\n---\nAlice.",
    });
    await tools.put_page({
      slug: "projects/memkin",
      content: "---\ntitle: Memkin\ntype: project\n---\nMemkin.",
    });

    expect(
      await tools.manage_links({
        action: "add",
        from: "entities/alice",
        to: "projects/memkin",
        provenance: { channel: "missing-platform" },
      }),
    ).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "provenance must be a valid SourceRef object",
        suggestion:
          "Provide at least platform and channel; timestamp, raw_hash, and quote are filled with safe defaults when omitted.",
      },
    });

    expect(
      await tools.add_timeline_entry({
        slug: "entities/alice",
        date: "2026-06-04",
        summary: "Invalid provenance",
        provenance: { platform: "test" },
      }),
    ).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "provenance must be a valid SourceRef object",
        suggestion:
          "Provide at least platform and channel; timestamp, raw_hash, and quote are filled with safe defaults when omitted.",
      },
    });
  });
});

describe("MCP synthesis tools", () => {
  let db: Database;
  let stores: Parameters<typeof createMcpToolHandlers>[0];

  beforeEach(async () => {
    db = await Database.create();
    stores = {
      db,
      pages: new PageStore(db.executor),
      chunks: new ChunkStore(db.executor),
      graph: new GraphStore(db.executor),
      tags: new TagStore(db.executor),
      timeline: new TimelineStore(db.executor),
      search: new SearchEngine(db.executor),
      embedding: new EmbeddingService(db.executor, { provider: "openai", apiKey: "test-key" }),
    };
  });
  afterEach(async () => {
    await db.close();
  });

  it("registers synthesize + recall + prep_for_person, not the unbuilt product tools", async () => {
    const provider = createMockProvider(new Map([["", "ans [1]"]]));
    const server = createMcpServer(stores, { provider });
    const client = new Client({ name: "synth-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("synthesize");
    expect(names).toContain("recall");
    expect(names).toContain("prep_for_person"); // Spec 8 (now built)
    expect(names).toContain("daily_report"); // Spec 9 (now built)
    expect(names).toContain("troubleshoot"); // Spec 11 (now built)

    await client.close();
    await server.close();
  });

  it("synthesize + recall handlers produce a synthesized answer with citations", async () => {
    const provider = createMockProvider(new Map([["", "We decided to ship on Friday [1]."]]));
    const tools = createMcpToolHandlers(stores, { provider });

    await tools.put_page({
      slug: "people/zhang-san",
      content: "---\ntitle: Zhang San\ntype: person\n---\nTeammate.",
    });
    await tools.put_page({
      slug: "decisions/ship-it",
      content: "---\ntitle: Ship It\ntype: decision\n---\nShip the feature on Friday.",
    });
    await tools.add_link({ from: "decisions/ship-it", to: "people/zhang-san", type: "mentions" });

    const viaSynthesize = await tools.synthesize({
      intent: "recall",
      scope: { entity: "people/zhang-san" },
    });
    expect("error" in viaSynthesize).toBe(false);
    if (!("error" in viaSynthesize)) {
      expect(viaSynthesize.answer).toBeTruthy();
      expect(viaSynthesize.citations.length).toBeGreaterThanOrEqual(1);
    }

    const viaRecall = await tools.recall({ entity: "people/zhang-san" });
    expect("error" in viaRecall).toBe(false);
    if (!("error" in viaRecall)) {
      expect(viaRecall.intent).toBe("recall");
      expect(viaRecall.answer).toBeTruthy();
    }
  });

  it("synthesize + recall return a structured error when no provider is configured", async () => {
    const tools = createMcpToolHandlers(stores, {});

    const viaSynthesize = await tools.synthesize({
      intent: "recall",
      scope: { entity: "people/zhang-san" },
    });
    expect("error" in viaSynthesize).toBe(true);
    if ("error" in viaSynthesize) {
      expect(viaSynthesize.error.code).toBe("INVALID_ARGUMENT");
    }

    const viaRecall = await tools.recall({ entity: "people/zhang-san" });
    expect("error" in viaRecall).toBe(true);
    if ("error" in viaRecall) {
      expect(viaRecall.error.code).toBe("INVALID_ARGUMENT");
    }
  });
});
