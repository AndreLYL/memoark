import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreContext } from "../../src/server/api.js";
import { ChunkStore } from "../../src/store/chunks.js";
import { Database } from "../../src/store/database.js";
import { GraphStore } from "../../src/store/graph.js";
import { PageStore } from "../../src/store/pages.js";
import { SearchEngine } from "../../src/store/search.js";
import { TimelineStore } from "../../src/store/timeline.js";
import { retrieve } from "../../src/synth/scope.js";

describe("synth/scope retrieve", () => {
  let db: Database;
  let pages: PageStore;
  let chunks: ChunkStore;
  let graph: GraphStore;
  let timeline: TimelineStore;
  let search: SearchEngine;
  let stores: StoreContext;

  beforeEach(async () => {
    db = await Database.create();
    pages = new PageStore(db.executor);
    chunks = new ChunkStore(db.executor);
    graph = new GraphStore(db.executor);
    timeline = new TimelineStore(db.executor);
    search = new SearchEngine(db.executor);
    stores = { db, pages, chunks, graph, timeline, search } as unknown as StoreContext;
  });

  afterEach(async () => {
    await db.close();
  });

  it("entity scope returns backlinks + timeline as candidates", async () => {
    await pages.putPage(
      "people/zhang-san",
      "---\ntitle: Zhang San\ntype: person\n---\nZhang San is a teammate.",
    );
    const d = await pages.putPage(
      "decisions/ship-it",
      "---\ntitle: Ship It\ntype: decision\n---\nWe decided to ship the feature on Friday.",
    );
    await chunks.rechunk(d.id, d.compiled_truth);
    await graph.addLink("decisions/ship-it", "people/zhang-san", "mentions");
    await timeline.addEntry("people/zhang-san", {
      date: "2026-06-10",
      summary: "Met Zhang San to align on the roadmap",
    });

    const candidates = await retrieve({ entity: "people/zhang-san" }, {}, stores);
    const slugs = candidates.map((c) => c.slug);
    expect(slugs).toContain("decisions/ship-it");
    // timeline entry is also surfaced as a candidate anchored to the entity
    expect(candidates.some((c) => c.text.includes("roadmap"))).toBe(true);
  });

  it("query scope routes through search.query with poolByPage", async () => {
    const spy = vi.spyOn(search, "query").mockResolvedValue([
      {
        slug: "decisions/use-pglite",
        title: "Use PGLite",
        type: "decision",
        snippet: "we chose pglite",
        score: 1,
        highlights: [],
      },
    ]);

    const candidates = await retrieve(
      { query: "database choice", types: ["decision"], limit: 5 },
      {},
      stores,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [q, opts] = spy.mock.calls[0];
    expect(q).toBe("database choice");
    expect(opts).toMatchObject({ poolByPage: true, type: ["decision"] });
    expect(candidates[0].slug).toBe("decisions/use-pglite");
  });

  it("time scope filters pages/timeline by date window", async () => {
    const inWindow = await pages.putPage(
      "notes/in-window",
      [
        "---",
        "title: In Window",
        "type: note",
        "source:",
        "  platform: test",
        "  channel: notes/in",
        "  timestamp: 2026-06-10T09:00:00.000Z",
        "  raw_hash: in",
        "  quote: in",
        "---",
        "An event inside the window.",
      ].join("\n"),
    );
    await chunks.rechunk(inWindow.id, inWindow.compiled_truth);

    const outOfWindow = await pages.putPage(
      "notes/out-window",
      [
        "---",
        "title: Out Window",
        "type: note",
        "source:",
        "  platform: test",
        "  channel: notes/out",
        "  timestamp: 2026-01-01T09:00:00.000Z",
        "  raw_hash: out",
        "  quote: out",
        "---",
        "An event outside the window.",
      ].join("\n"),
    );
    await chunks.rechunk(outOfWindow.id, outOfWindow.compiled_truth);

    const candidates = await retrieve(
      { time: { from: "2026-06-01", to: "2026-06-30" } },
      {},
      stores,
    );
    const slugs = candidates.map((c) => c.slug);
    expect(slugs).toContain("notes/in-window");
    expect(slugs).not.toContain("notes/out-window");
  });

  it("time scope uses the newest active contribution and excludes unknown source times", async () => {
    const contributed = await pages.putPage(
      "notes/multi-source",
      [
        "---",
        "title: Multi Source",
        "type: note",
        "source:",
        "  platform: test",
        "  channel: old",
        "  timestamp: 2021-01-01T00:00:00.000Z",
        "---",
        "Recently discussed historical note.",
      ].join("\n"),
    );
    await pages.putPage(
      "notes/unknown-time",
      "---\ntitle: Unknown Time\ntype: note\n---\nNo source timestamp.",
    );
    await db.executor.query(
      `INSERT INTO memory_contributions
         (contribution_id, signal_family_key, canonical_page_id, session_ref, revision_id,
          authority, signal_type, normalized_topic, signal, source_ref, active)
       VALUES
         ('scope-old', 'scope-old-family', $1, 'ref', 1, 'user_confirmed', 'knowledge', 'old', '{}'::jsonb,
          '{"platform":"test","channel":"old","timestamp":"2021-01-01T00:00:00.000Z"}'::jsonb, true),
         ('scope-recent', 'scope-recent-family', $1, 'ref', 1, 'assistant_claimed', 'knowledge', 'recent', '{}'::jsonb,
          '{"platform":"test","channel":"recent","timestamp":"2026-09-03T00:00:00.000Z"}'::jsonb, true)`,
      [contributed.id],
    );

    const candidates = await retrieve(
      { time: { from: "2026-09-01", to: "2026-09-06" } },
      {},
      stores,
    );

    expect(candidates.map((candidate) => candidate.slug)).toEqual(["notes/multi-source"]);
    expect(candidates[0].date).toBe("2026-09-03T00:00:00.000Z");
    expect(candidates[0].source).toBe("recent");
  });
});
