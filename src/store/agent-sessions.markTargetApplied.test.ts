// src/store/agent-sessions.markTargetApplied.test.ts
//
// Covers the per-target apply marker added for the historical backfill driver:
// stamping staging_applied_at must NOT advance the state machine (a staging
// apply is not production-`done`) and is the idempotent resume marker.

import { describe, expect, it } from "vitest";
import { AgentSessionStore } from "./agent-sessions.js";
import { Database } from "./database.js";

async function seed(store: AgentSessionStore) {
  const res = await store.recordRevision({
    sourceInstance: "claude-code",
    sessionId: "s1",
    contentHash: "h1",
    byteSize: 10,
    lineCount: 2,
  });
  return res.revision.id;
}

describe("AgentSessionStore.markTargetApplied", () => {
  it("stamps staging_applied_at without changing state", async () => {
    const db = await Database.create(undefined, { embeddingDimensions: 768 });
    try {
      const store = new AgentSessionStore(db.executor);
      const id = await seed(store);
      await store.markState(id, "distilled");

      await store.markTargetApplied(id, "staging");

      const rev = await store.getRevision(id);
      expect(rev?.state).toBe("distilled");
      expect(rev?.stagingAppliedAt).not.toBeNull();
      expect(rev?.prodAppliedAt).toBeNull();
    } finally {
      await db.executor.close();
    }
  });

  it("stamps prod_applied_at for the production target", async () => {
    const db = await Database.create(undefined, { embeddingDimensions: 768 });
    try {
      const store = new AgentSessionStore(db.executor);
      const id = await seed(store);
      await store.markTargetApplied(id, "production");
      const rev = await store.getRevision(id);
      expect(rev?.prodAppliedAt).not.toBeNull();
      expect(rev?.stagingAppliedAt).toBeNull();
    } finally {
      await db.executor.close();
    }
  });

  it("throws for an unknown row", async () => {
    const db = await Database.create(undefined, { embeddingDimensions: 768 });
    try {
      const store = new AgentSessionStore(db.executor);
      await expect(store.markTargetApplied(9999, "staging")).rejects.toThrow();
    } finally {
      await db.executor.close();
    }
  });
});
