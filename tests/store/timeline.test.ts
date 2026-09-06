import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceRef } from "../../src/core/types.js";
import { Database } from "../../src/store/database.js";
import { PageStore } from "../../src/store/pages.js";
import { TimelineStore } from "../../src/store/timeline.js";

describe("TimelineStore", () => {
  let db: Database;
  let pages: PageStore;
  let timeline: TimelineStore;

  beforeEach(async () => {
    db = await Database.create();
    pages = new PageStore(db.executor);
    timeline = new TimelineStore(db.executor);
  });
  afterEach(async () => {
    await db.close();
  });

  function sourceRef(raw_hash: string, platform = "test"): SourceRef {
    return {
      platform,
      channel: `channel/${raw_hash}`,
      timestamp: "2026-06-04T10:00:00.000Z",
      raw_hash,
      quote: `quote ${raw_hash}`,
    };
  }

  it("addEntry and getTimeline", async () => {
    await pages.putPage("test/tl", "---\ntitle: T\ntype: test\n---\nBody.");
    await timeline.addEntry("test/tl", {
      date: "2026-05-25",
      summary: "Project started",
      detail: "Initial setup done",
      source: "chat",
    });
    await timeline.addEntry("test/tl", { date: "2026-05-26", summary: "First feature shipped" });
    const entries = await timeline.getTimeline("test/tl");
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe("2026-05-26");
    expect(entries[1].date).toBe("2026-05-25");
    expect(entries[1].detail).toBe("Initial setup done");
  });

  it("addEntry deduplicates on (page_id, date, summary)", async () => {
    await pages.putPage("test/dedup", "---\ntitle: D\ntype: test\n---\nBody.");
    await timeline.addEntry("test/dedup", {
      date: "2026-05-25",
      summary: "Same event",
      detail: "V1",
    });
    await timeline.addEntry("test/dedup", {
      date: "2026-05-25",
      summary: "Same event",
      detail: "V2 updated",
    });
    const entries = await timeline.getTimeline("test/dedup");
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toBe("V2 updated");
  });

  it("addEntry updates provenance on conflict", async () => {
    await pages.putPage("test/provenance", "---\ntitle: P\ntype: test\n---\nBody.");
    await timeline.addEntry("test/provenance", {
      date: "2026-06-04",
      summary: "Same event",
      provenance: sourceRef("first-hash"),
    });
    await timeline.addEntry("test/provenance", {
      date: "2026-06-04",
      summary: "Same event",
      provenance: sourceRef("latest-hash", "feishu"),
    });

    const entries = await timeline.getTimeline("test/provenance");
    expect(entries).toHaveLength(1);
    expect(entries[0].provenance).toMatchObject({
      platform: "feishu",
      raw_hash: "latest-hash",
    });
  });

  it("addEntry rejects missing page slugs instead of silently inserting zero rows", async () => {
    await expect(
      timeline.addEntry("missing/page", {
        date: "2026-06-04",
        summary: "Should fail",
      }),
    ).rejects.toThrow("Page not found: missing/page");
  });

  it("feed treats date-only to as end-of-day and datetime to as exact", async () => {
    await pages.putPage("test/time-a", "---\ntitle: Time A\ntype: test\n---\nBody.");
    await pages.putPage("test/time-b", "---\ntitle: Time B\ntype: test\n---\nBody.");
    await timeline.addEntry("test/time-a", {
      date: "2026-06-04T09:00:00.000Z",
      summary: "Morning event",
    });
    await timeline.addEntry("test/time-b", {
      date: "2026-06-04T11:00:00.000Z",
      summary: "Late event",
    });

    expect((await timeline.feed({ to: "2026-06-04" })).map((e) => e.slug).sort()).toEqual([
      "test/time-a",
      "test/time-b",
    ]);
    expect((await timeline.feed({ to: "2026-06-04T10:00:00.000Z" })).map((e) => e.slug)).toEqual([
      "test/time-a",
    ]);
  });

  it("feed skips historical partial and invalid dates instead of aborting a date window", async () => {
    await pages.putPage("test/historical-dates", "---\ntitle: Historical\ntype: test\n---\nBody.");
    await timeline.addEntry("test/historical-dates", {
      date: "2021-04",
      summary: "Known month but unknown day",
    });
    await timeline.addEntry("test/historical-dates", {
      date: "not-a-date",
      summary: "Malformed legacy date",
    });
    await timeline.addEntry("test/historical-dates", {
      date: "2026-09-03",
      summary: "Exact recent event",
    });

    await expect(timeline.feed({ from: "2026-09-01", to: "2026-09-06" })).resolves.toMatchObject([
      { summary: "Exact recent event" },
    ]);
  });

  it("getTimeline returns empty for page with no entries", async () => {
    await pages.putPage("test/empty", "---\ntitle: E\ntype: test\n---\nBody.");
    const entries = await timeline.getTimeline("test/empty");
    expect(entries).toEqual([]);
  });

  it("entries cascade on page delete", async () => {
    await pages.putPage("test/del", "---\ntitle: D\ntype: test\n---\nBody.");
    await timeline.addEntry("test/del", { date: "2026-05-25", summary: "Event" });
    await pages.deletePage("test/del");
    const count = await db.executor.query("SELECT COUNT(*) AS c FROM timeline_entries");
    expect(Number(count.rows[0].c)).toBe(0);
  });

  it("getAllTimelineGrouped returns Map<slug, entries[]> for batch export", async () => {
    await pages.putPage("a", "---\ntitle: A\ntype: t\n---\n");
    await pages.putPage("b", "---\ntitle: B\ntype: t\n---\n");
    await timeline.addEntry("a", { date: "2026-05-20", summary: "Event 1" });
    await timeline.addEntry("a", { date: "2026-05-21", summary: "Event 2" });
    await timeline.addEntry("b", { date: "2026-05-22", summary: "Event B" });

    const grouped = await timeline.getAllTimelineGrouped();

    expect(grouped.get("a")).toHaveLength(2);
    expect(grouped.get("b")).toHaveLength(1);
    expect(grouped.get("b")?.[0].summary).toBe("Event B");
    expect(grouped.has("nonexistent")).toBe(false);
  });

  it("getAllTimelineGrouped returns empty Map when no entries", async () => {
    const grouped = await timeline.getAllTimelineGrouped();
    expect(grouped.size).toBe(0);
  });
});
