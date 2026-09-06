import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../store/database.js";
import { GraphStore } from "../store/graph.js";
import { PageStore } from "../store/pages.js";
import { TagStore } from "../store/tags.js";
import { TimelineStore } from "../store/timeline.js";
import { getSessionContext } from "./context.js";

describe("getSessionContext recent-time contract", () => {
  let db: Database;
  let pages: PageStore;

  beforeEach(async () => {
    db = await Database.create(undefined, { embeddingDimensions: 768 });
    pages = new PageStore(db.executor);
  });

  afterEach(async () => {
    await db.close();
  });

  it("uses source activity rather than mutable updated_at and labels unbounded state", async () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const page = (slug: string, title: string, type: string, timestamp?: string, extra = "") =>
      [
        "---",
        `title: ${title}`,
        `type: ${type}`,
        extra,
        ...(timestamp
          ? ["source:", "  platform: test", `  channel: ${slug}`, `  timestamp: ${timestamp}`]
          : []),
        "---",
        title,
      ]
        .filter(Boolean)
        .join("\n");

    await pages.putPage(
      "projects/old-but-rewritten",
      page("projects/old-but-rewritten", "Old rewritten project", "project", old),
    );
    // A second write refreshes pages.updated_at to now but must not refresh source activity.
    await pages.putPage(
      "projects/old-but-rewritten",
      page("projects/old-but-rewritten", "Old rewritten project", "project", old),
    );
    await pages.putPage(
      "projects/recent",
      page("projects/recent", "Recent project", "project", recent),
    );
    const contributionProject = await pages.putPage(
      "projects/contribution-recent",
      page("projects/contribution-recent", "Contribution recent project", "project", old),
    );
    await db.executor.query(
      `INSERT INTO memory_contributions
         (contribution_id, signal_family_key, canonical_page_id, session_ref, revision_id,
          authority, signal_type, normalized_topic, signal, source_ref, active)
       VALUES ('contribution-id-is-not-page-id', 'context-family', $1, 'ref', 1,
          'user_confirmed', 'knowledge', 'context', '{}'::jsonb, $2::jsonb, true)`,
      [
        contributionProject.id,
        JSON.stringify({
          platform: "test",
          channel: "projects/contribution-recent",
          timestamp: recent,
        }),
      ],
    );
    await pages.putPage(
      "decisions/recent",
      page("decisions/recent", "Recent decision", "decision", recent),
    );
    await pages.putPage(
      "decisions/unknown",
      page("decisions/unknown", "Unknown decision", "decision"),
    );
    await pages.putPage(
      "tasks/open",
      page("tasks/open", "Open task", "task", undefined, "status: open"),
    );
    await pages.putPage(
      "preferences/editor",
      page("preferences/editor", "Editor preference", "preference"),
    );
    await pages.putPage("people/alice", page("people/alice", "Alice", "person"));

    const context = await getSessionContext({
      pages,
      graph: new GraphStore(db.executor),
      tags: new TagStore(db.executor),
      timeline: new TimelineStore(db.executor),
    });

    expect(context).toContain("projects/recent");
    expect(context).toContain("projects/contribution-recent");
    expect(context).toContain("Recent decision");
    expect(context).not.toContain("old-but-rewritten");
    expect(context).not.toContain("Unknown decision");
    expect(context).toContain("当前状态，不限时间窗");
    expect(context).toContain("Open task");
    expect(context).toContain("Editor preference");
    expect(context).toContain("Alice");
  });
});
