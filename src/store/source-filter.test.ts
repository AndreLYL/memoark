import { describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { PageStore } from "./pages.js";
import { SearchEngine } from "./search.js";
import { safeTimestampExpr } from "./source-filter.js";
import { TimelineStore } from "./timeline.js";

async function addContribution(
  db: Awaited<ReturnType<typeof Database.create>>,
  pageId: number,
  cid: string,
  platform: string,
): Promise<void> {
  await db.executor.query(
    `INSERT INTO memory_contributions
       (contribution_id, signal_family_key, canonical_page_id, session_ref, revision_id,
        authority, signal_type, normalized_topic, signal, source_ref, active)
     VALUES ($1, $1, $2, 'ref', 1, 'user_confirmed', 'decision', $1, '{}'::jsonb, $3::jsonb, true)`,
    [
      cid,
      pageId,
      JSON.stringify({ platform, channel: "c", timestamp: "2026-07-01T00:00:00.000Z" }),
    ],
  );
}

describe("source filtering via active contributions (spec §8, PR-4)", () => {
  it("safeTimestampExpr accepts only exact ISO dates or zoned datetimes", async () => {
    const db = await Database.create(undefined, { embeddingDimensions: 768 });
    try {
      const parse = async (value: string) =>
        (
          await db.executor.query<{ value: string | Date | null }>(
            `SELECT ${safeTimestampExpr("$1::text")} AS value`,
            [value],
          )
        ).rows[0].value;

      expect(await parse("2026-09-03")).not.toBeNull();
      expect(await parse("2026-09-03T12:34:56.789Z")).not.toBeNull();
      expect(await parse("2026-09-03T21:34:56+09:00")).not.toBeNull();
      for (const unsafe of [
        "2021-04",
        "2026-02-30",
        "not-a-date",
        "now",
        "today",
        "infinity",
        "04/05/2026",
        "2026-09-03T12:34:56",
      ]) {
        expect(await parse(unsafe), unsafe).toBeNull();
      }
    } finally {
      await db.executor.close();
    }
  });

  it("finds a multi-source page by its NON-primary platform (search)", async () => {
    const db = await Database.create(undefined, { embeddingDimensions: 768 });
    try {
      const pages = new PageStore(db.executor);
      // Primary (frontmatter) platform is feishu; a second contribution is claude-code.
      const p = await pages.putPage(
        "decisions/multi",
        "---\ntitle: Multi\ntype: decision\nsource:\n  platform: feishu\n  channel: c\n---\nkeyword body here",
      );
      await addContribution(db, p.id, "c-feishu", "feishu");
      await addContribution(db, p.id, "c-claude", "claude-code");

      const search = new SearchEngine(db.executor);
      const byPrimary = await search.search("keyword", { platform: "feishu" });
      const bySecondary = await search.search("keyword", { platform: "claude-code" });
      expect(byPrimary.map((r) => r.slug)).toContain("decisions/multi");
      expect(bySecondary.map((r) => r.slug)).toContain("decisions/multi");
    } finally {
      await db.executor.close();
    }
  });

  it("falls back to frontmatter for legacy pages without contributions (search)", async () => {
    const db = await Database.create(undefined, { embeddingDimensions: 768 });
    try {
      const pages = new PageStore(db.executor);
      await pages.putPage(
        "decisions/legacy",
        "---\ntitle: Legacy\ntype: decision\nsource:\n  platform: email\n  channel: c\n---\nkeyword legacy body",
      );
      const search = new SearchEngine(db.executor);
      const hit = await search.search("keyword", { platform: "email" });
      const miss = await search.search("keyword", { platform: "claude-code" });
      expect(hit.map((r) => r.slug)).toContain("decisions/legacy");
      expect(miss.map((r) => r.slug)).not.toContain("decisions/legacy");
    } finally {
      await db.executor.close();
    }
  });

  it("finds a multi-source page by its NON-primary platform (timeline feed)", async () => {
    const db = await Database.create(undefined, { embeddingDimensions: 768 });
    try {
      const pages = new PageStore(db.executor);
      const p = await pages.putPage(
        "decisions/tl",
        "---\ntitle: TL\ntype: decision\nsource:\n  platform: feishu\n  channel: c\n---\nbody",
      );
      await addContribution(db, p.id, "tl-feishu", "feishu");
      await addContribution(db, p.id, "tl-claude", "claude-code");

      const timeline = new TimelineStore(db.executor);
      await timeline.addEntry("decisions/tl", {
        date: "2026-07-01T00:00:00.000Z",
        summary: "did a thing",
      });

      const bySecondary = await timeline.feed({ platform: "claude-code" });
      expect(bySecondary.map((r) => r.slug)).toContain("decisions/tl");
    } finally {
      await db.executor.close();
    }
  });
});
