import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChunkStore } from "../../src/store/chunks.js";
import { Database } from "../../src/store/database.js";
import { PageStore } from "../../src/store/pages.js";
import { SearchEngine } from "../../src/store/search.js";

describe("SearchEngine — FTS", () => {
  let db: Database;
  let pageStore: PageStore;
  let chunkStore: ChunkStore;
  let search: SearchEngine;

  beforeEach(async () => {
    db = await Database.create();
    pageStore = new PageStore(db.executor);
    chunkStore = new ChunkStore(db.executor);
    search = new SearchEngine(db.executor);

    const p1 = await pageStore.putPage(
      "entities/alice",
      "---\ntitle: Alice\ntype: person\n---\nAlice is a software engineer working on distributed systems.",
    );
    await chunkStore.rechunk(p1.id, p1.compiled_truth);

    const p2 = await pageStore.putPage(
      "entities/bob",
      "---\ntitle: Bob\ntype: person\n---\nBob is a product manager focused on machine learning products.",
    );
    await chunkStore.rechunk(p2.id, p2.compiled_truth);

    const p3 = await pageStore.putPage(
      "decisions/tech-stack",
      "---\ntitle: Tech Stack Decision\ntype: decision\n---\nWe chose PostgreSQL for the database and TypeScript for the backend.",
    );
    await chunkStore.rechunk(p3.id, p3.compiled_truth);
  });

  afterEach(async () => {
    await db.close();
  });

  it("search returns matching pages by keyword", async () => {
    const results = await search.search("engineer");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.slug === "entities/alice")).toBe(true);
  });

  it("search returns empty for no match", async () => {
    const results = await search.search("quantum");
    expect(results).toHaveLength(0);
  });

  it("search respects limit", async () => {
    const results = await search.search("is", { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("search ranks page-level title matches higher (weight A)", async () => {
    const results = await search.search("Alice");
    expect(results[0].slug).toBe("entities/alice");
  });

  it("search returns page metadata in results", async () => {
    const results = await search.search("PostgreSQL");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const r = results.find((x) => x.slug === "decisions/tech-stack");
    expect(r).toBeDefined();
    expect(r.title).toBe("Tech Stack Decision");
    expect(r.type).toBe("decision");
    expect(r.snippet).toBeTruthy();
  });

  it("search handles multi-word queries", async () => {
    const results = await search.search("machine learning");
    expect(results.some((r) => r.slug === "entities/bob")).toBe(true);
  });

  it("search and query apply platform, source_type, and participant filters consistently", async () => {
    const wechat = await pageStore.putPage(
      "projects/memkin-wechat-deploy",
      [
        "---",
        "title: Memkin WeChat Deploy",
        "type: decision",
        "source:",
        "  platform: wechat",
        "  source_type: dm",
        "  channel: dm/wechat/wxid_zhangsan",
        "  channel_name: 张三",
        "  timestamp: 2026-06-04T10:00:00.000Z",
        "  raw_hash: wx-hash",
        "  quote: 微信里确认部署方案",
        "  participants:",
        "    - name: 张三",
        "      role: participant",
        "---",
        "Memkin deployment uses PGLite for local storage.",
      ].join("\n"),
    );
    await chunkStore.rechunk(wechat.id, wechat.compiled_truth);

    const feishu = await pageStore.putPage(
      "projects/memkin-feishu-deploy",
      [
        "---",
        "title: Memkin Feishu Deploy",
        "type: decision",
        "source:",
        "  platform: feishu",
        "  source_type: group",
        "  channel: group/feishu/oc_project",
        "  channel_name: 项目群",
        "  timestamp: 2026-06-04T11:00:00.000Z",
        "  raw_hash: fs-hash",
        "  quote: 飞书群确认部署方案",
        "  participants:",
        "    - name: 李四",
        "      role: participant",
        "---",
        "Memkin deployment uses cloud Postgres for shared staging.",
      ].join("\n"),
    );
    await chunkStore.rechunk(feishu.id, feishu.compiled_truth);

    const searchResults = await search.search("Memkin deployment", {
      platform: "wechat",
      source_type: "dm",
      participant: "张三",
    });
    const queryResults = await search.query("Memkin deployment", {
      platform: "wechat",
      source_type: "dm",
      participant: "张三",
    });

    expect(searchResults.map((r) => r.slug)).toEqual(["projects/memkin-wechat-deploy"]);
    expect(queryResults.map((r) => r.slug)).toEqual(["projects/memkin-wechat-deploy"]);
    expect(searchResults[0].provenance?.platform).toBe("wechat");
    expect(queryResults[0].provenance?.participants?.[0]?.name).toBe("张三");
  });

  it("search and query apply exclude_types", async () => {
    const person = await pageStore.putPage(
      "people/excluded-search",
      "---\ntitle: Excluded Search Person\ntype: person\n---\nsharedexclude searchable text.",
    );
    await chunkStore.rechunk(person.id, person.compiled_truth);

    const decision = await pageStore.putPage(
      "decisions/included-search",
      "---\ntitle: Included Search Decision\ntype: decision\n---\nsharedexclude searchable text.",
    );
    await chunkStore.rechunk(decision.id, decision.compiled_truth);

    expect(
      (await search.search("sharedexclude", { exclude_types: ["person"] })).map((r) => r.slug),
    ).toEqual(["decisions/included-search"]);
    expect(
      (await search.query("sharedexclude", { exclude_types: ["person"] })).map((r) => r.slug),
    ).toEqual(["decisions/included-search"]);
  });

  it("search treats date-only to as end-of-day and datetime to as exact", async () => {
    const morning = await pageStore.putPage(
      "time/morning",
      [
        "---",
        "title: Morning",
        "type: note",
        "source:",
        "  platform: test",
        "  channel: time/morning",
        "  timestamp: 2026-06-04T09:00:00.000Z",
        "  raw_hash: morning",
        "  quote: morning",
        "---",
        "timebound searchable text.",
      ].join("\n"),
    );
    await chunkStore.rechunk(morning.id, morning.compiled_truth);

    const late = await pageStore.putPage(
      "time/late",
      [
        "---",
        "title: Late",
        "type: note",
        "source:",
        "  platform: test",
        "  channel: time/late",
        "  timestamp: 2026-06-04T11:00:00.000Z",
        "  raw_hash: late",
        "  quote: late",
        "---",
        "timebound searchable text.",
      ].join("\n"),
    );
    await chunkStore.rechunk(late.id, late.compiled_truth);

    expect(
      (await search.search("timebound", { to: "2026-06-04" })).map((r) => r.slug).sort(),
    ).toEqual(["time/late", "time/morning"]);
    expect(
      (await search.search("timebound", { to: "2026-06-04T10:00:00.000Z" })).map((r) => r.slug),
    ).toEqual(["time/morning"]);
  });

  it("date filters use the latest valid active source time and keep unknown dates unknown", async () => {
    const addPage = async (slug: string, timestamp?: string) => {
      const source = timestamp
        ? [
            "source:",
            "  platform: test",
            `  channel: ${slug}`,
            `  timestamp: ${timestamp}`,
            `  raw_hash: ${slug}`,
            "  quote: evidence",
          ]
        : [];
      const page = await pageStore.putPage(
        slug,
        ["---", `title: ${slug}`, "type: note", ...source, "---", "windowword evidence"].join("\n"),
      );
      await chunkStore.rechunk(page.id, page.compiled_truth);
      return page;
    };

    await addPage("notes/source-missing");
    await addPage("notes/source-partial", "2021-04");
    const contributed = await addPage("notes/contributed", "2021-01-01T00:00:00.000Z");
    await db.executor.query(
      `INSERT INTO memory_contributions
         (contribution_id, signal_family_key, canonical_page_id, session_ref, revision_id,
          authority, signal_type, normalized_topic, signal, source_ref, active)
       VALUES
         ('old', 'old-family', $1, 'ref', 1, 'user_confirmed', 'knowledge', 'old', '{}'::jsonb,
          '{"platform":"test","channel":"old","timestamp":"2021-01-01T00:00:00.000Z"}'::jsonb, true),
         ('recent', 'recent-family', $1, 'ref', 1, 'assistant_claimed', 'knowledge', 'recent', '{}'::jsonb,
          '{"platform":"test","channel":"recent","timestamp":"2026-09-03T00:00:00.000Z"}'::jsonb, true)`,
      [contributed.id],
    );

    const filter = { from: "2026-09-01", to: "2026-09-06" };
    await expect(search.search("windowword", filter)).resolves.toMatchObject([
      { slug: "notes/contributed" },
    ]);
    await expect(search.query("windowword", filter)).resolves.toMatchObject([
      { slug: "notes/contributed" },
    ]);
  });

  it("clamps oversized search and query limits", async () => {
    for (let i = 0; i < 55; i++) {
      const page = await pageStore.putPage(
        `test/clamp-${i}`,
        `---\ntitle: Clamp ${i}\ntype: note\n---\nclampword appears in this memory ${i}.`,
      );
      await chunkStore.rechunk(page.id, page.compiled_truth);
    }

    expect(await search.search("clampword", { limit: 999 })).toHaveLength(50);
    expect(await search.query("clampword", { limit: 999 })).toHaveLength(50);
  });

  it("search() recalls Chinese exact-substring queries", async () => {
    const p1 = await pageStore.putPage(
      "decisions/rollback",
      "---\ntitle: 上线回滚开关\ntype: decision\n---\n上线回滚开关的设计决策",
    );
    await chunkStore.rechunk(p1.id, p1.compiled_truth);
    const p2 = await pageStore.putPage(
      "knowledge/mw",
      "---\ntitle: 认证中间件\ntype: knowledge\n---\n认证中间件链路梳理",
    );
    await chunkStore.rechunk(p2.id, p2.compiled_truth);
    expect((await search.search("回滚")).map((r) => r.slug)).toContain("decisions/rollback");
    expect((await search.search("中间件")).map((r) => r.slug)).toContain("knowledge/mw");
  });

  it("search() returns [] for empty/whitespace query", async () => {
    expect(await search.search("   ")).toEqual([]);
  });
});
