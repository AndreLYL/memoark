import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSessionStore } from "../store/agent-sessions.js";
import { Database } from "../store/database.js";
import { readMeta } from "../store/store-meta.js";
import { scanAgentSessions } from "./agent-session-scanner.js";

let db: Database;
let store: AgentSessionStore;
let dir: string;

beforeEach(async () => {
  db = await Database.create(undefined, { embeddingDimensions: 768 });
  store = new AgentSessionStore(db.executor);
  dir = await mkdtemp(join(tmpdir(), "memkin-scan-"));
});

afterEach(async () => {
  await db.executor.close();
  await rm(dir, { recursive: true, force: true });
});

// A layout matching claude-code: <base>/<project>/<sessionId>.jsonl → sessionId from basename.
function layout(baseDir: string) {
  return {
    baseDir,
    glob: "*/*.jsonl",
    sessionIdFromPath: (p: string) => p.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
    channelFromPath: (_p: string, sid: string) => sid,
  };
}

async function writeSession(project: string, sessionId: string, content: string, mtime?: Date) {
  const projDir = join(dir, project);
  await writeFile(join(projDir, `${sessionId}.jsonl`), content, "utf-8").catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, `${sessionId}.jsonl`), content, "utf-8");
  });
  if (mtime) await utimes(join(projDir, `${sessionId}.jsonl`), mtime, mtime);
}

describe("scanAgentSessions", () => {
  it("records a discovered row per stable session revision", async () => {
    await writeSession("proj", "sess-1", '{"a":1}\n');
    await writeSession("proj", "sess-2", '{"b":2}\n');

    const res = await scanAgentSessions({
      sourceInstance: "claude-code",
      layout: layout(dir),
      store,
      executor: db.executor,
    });

    expect(res.discovered).toBe(2);
    const rows = await store.listSessions({ sourceInstance: "claude-code" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "discovered")).toBe(true);
  });

  it("skips files older than sinceMs (the --since backfill window)", async () => {
    const old = new Date(Date.now() - 10 * 86_400_000); // 10 days ago
    const recent = new Date(Date.now() - 60_000);
    await writeSession("proj", "old-sess", '{"a":1}\n', old);
    await writeSession("proj", "new-sess", '{"b":2}\n', recent);

    const res = await scanAgentSessions({
      sourceInstance: "claude-code",
      layout: layout(dir),
      store,
      executor: db.executor,
      sinceMs: Date.now() - 2 * 86_400_000, // 2 days ago
    });

    expect(res.discovered).toBe(1);
    const rows = await store.listSessions({ sourceInstance: "claude-code" });
    expect(rows.map((r) => r.sessionId)).toEqual(["new-sess"]);
  });

  it("does not create a new row when content is unchanged on a second scan", async () => {
    await writeSession("proj", "sess-1", '{"a":1}\n');
    const opts = {
      sourceInstance: "claude-code" as const,
      layout: layout(dir),
      store,
      executor: db.executor,
    };
    await scanAgentSessions(opts);
    const res2 = await scanAgentSessions(opts);
    expect(res2.discovered).toBe(0);
    const rows = await store.listSessions({ sourceInstance: "claude-code" });
    expect(rows).toHaveLength(1);
  });

  it("records a new revision when a session's content changes", async () => {
    await writeSession("proj", "sess-1", '{"a":1}\n');
    const opts = {
      sourceInstance: "claude-code" as const,
      layout: layout(dir),
      store,
      executor: db.executor,
    };
    await scanAgentSessions(opts);
    await writeSession("proj", "sess-1", '{"a":1}\n{"a":2}\n');
    const res2 = await scanAgentSessions(opts);
    expect(res2.revised).toBe(1);
    const rows = await store.listSessions({ sourceInstance: "claude-code" });
    expect(rows).toHaveLength(2);
  });

  it("advances the watermark independently of session state", async () => {
    const t1 = new Date(Date.now() - 60_000);
    await writeSession("proj", "sess-1", '{"a":1}\n', t1);

    await scanAgentSessions({
      sourceInstance: "claude-code",
      layout: layout(dir),
      store,
      executor: db.executor,
    });

    const wm = await readMeta(db.executor, "agent_watermark:claude-code");
    expect(wm).not.toBeNull();
    const wmValue = Number(wm);
    expect(wmValue).toBeGreaterThan(0);

    // Even if a session is dead_lettered, the watermark still advances on the next scan
    // that sees a newer file.
    const rows = await store.listSessions({ sourceInstance: "claude-code" });
    await store.markState(rows[0].id, "distilled");
    await store.markState(rows[0].id, "retrying");
    await store.markState(rows[0].id, "dead_letter");

    const t2 = new Date(Date.now() + 60_000);
    await writeSession("proj", "sess-2", '{"b":2}\n', t2);
    await scanAgentSessions({
      sourceInstance: "claude-code",
      layout: layout(dir),
      store,
      executor: db.executor,
    });
    const wm2 = await readMeta(db.executor, "agent_watermark:claude-code");
    expect(Number(wm2)).toBeGreaterThan(wmValue);
  });
});
