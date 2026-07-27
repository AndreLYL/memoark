// src/backfill/driver.test.ts
//
// Unit tests for the backfill ORCHESTRATION (mock scanner / distiller / engine /
// ledger — no DB, no LLM). Proves the driver's contract: scan → distill → staging
// apply, honoring --limit / --dry-run, idempotent resume via staging_applied_at,
// and production-leak aggregation.

import { describe, expect, it, vi } from "vitest";
import type { ShadowRunOutcome } from "../apply/shadow-runner.js";
import type { SessionRevision } from "../store/agent-sessions.js";
import type { StoredPayload } from "../store/distilled-payload.js";
import {
  BackfillDriver,
  type BackfillDriverDeps,
  type DistillStep,
  type ScanStep,
  type ScanSummary,
  type SessionLedger,
  type StageApplyStep,
} from "./driver.js";

function scanSummary(over: Partial<ScanSummary> = {}): ScanSummary {
  return { perSource: {}, scanned: 0, discovered: 0, revised: 0, skipped: 0, ...over };
}

function revision(over: Partial<SessionRevision> = {}): SessionRevision {
  return {
    id: 1,
    sourceInstance: "claude-code",
    sessionId: "s1",
    contentHash: "h1",
    byteSize: 10,
    lineCount: 2,
    state: "distilled",
    retryCount: 0,
    payloadId: 100,
    stagingAppliedAt: null,
    prodAppliedAt: null,
    discoveredAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function payload(revisionId: number): StoredPayload {
  return {
    id: revisionId + 1000,
    sourceInstance: "claude-code",
    sessionId: "s1",
    revisionId,
    contentHash: "h1",
    payload: { signals: [] },
    restorationMap: null,
    ttlExpiresAt: null,
    createdAt: "2026-06-01T00:00:00Z",
  };
}

function shadowOutcome(over: Partial<ShadowRunOutcome> = {}): ShadowRunOutcome {
  return {
    payloadId: 1,
    planId: 7,
    productionLeak: 0,
    apply: {
      attemptId: 1,
      status: "applied",
      target: "staging",
      applied: [],
      retried: false,
      replay: false,
    },
    ...over,
  };
}

interface Harness {
  deps: BackfillDriverDeps;
  scan: ReturnType<typeof vi.fn>;
  runTick: ReturnType<typeof vi.fn>;
  stageRun: ReturnType<typeof vi.fn>;
  markTargetApplied: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  scan?: ScanSummary;
  discovered?: SessionRevision[];
  distilled?: SessionRevision[];
  stageOutcome?: (payloadId: number) => ShadowRunOutcome;
}): Harness {
  const scan = vi.fn(async () => opts.scan ?? scanSummary());
  const runTick = vi.fn(async () => ({
    considered: 0,
    distilled: 0,
    skipped: 0,
    failed: 0,
    deadLettered: 0,
    replayed: 0,
  }));
  const stageRun = vi.fn(async (payloadId: number) =>
    opts.stageOutcome ? opts.stageOutcome(payloadId) : shadowOutcome({ payloadId }),
  );
  const markTargetApplied = vi.fn(async () => {});
  const listSessions = vi.fn(async (q?: { state?: string }) => {
    if (q?.state === "discovered") return opts.discovered ?? [];
    if (q?.state === "distilled") return opts.distilled ?? [];
    return [];
  });

  const scanStep: ScanStep = { scan };
  const distiller: DistillStep = { runTick };
  const stageApplier: StageApplyStep = { run: stageRun };
  const ledger: SessionLedger = {
    listSessions: listSessions as SessionLedger["listSessions"],
    markTargetApplied: markTargetApplied as SessionLedger["markTargetApplied"],
  };
  const payloads = {
    getByRevision: async (revisionId: number) => payload(revisionId),
  };

  return {
    deps: { scanStep, distiller, stageApplier, ledger, payloads },
    scan,
    runTick,
    stageRun,
    markTargetApplied,
    listSessions,
  };
}

describe("BackfillDriver", () => {
  it("dry-run scans and projects work without distilling or applying", async () => {
    const h = harness({
      scan: scanSummary({ scanned: 5, discovered: 3 }),
      discovered: [revision({ id: 1 }), revision({ id: 2 }), revision({ id: 3 })],
      distilled: [],
    });
    const driver = new BackfillDriver(h.deps);

    const res = await driver.run({ dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.scan.discovered).toBe(3);
    expect(res.projection).toEqual({ wouldDistill: 3, wouldStageApply: 0 });
    expect(h.runTick).not.toHaveBeenCalled();
    expect(h.stageRun).not.toHaveBeenCalled();
  });

  it("dry-run projection respects --limit", async () => {
    const h = harness({
      discovered: [revision({ id: 1 }), revision({ id: 2 }), revision({ id: 3 })],
      distilled: [revision({ id: 4, stagingAppliedAt: null })],
    });
    const res = await new BackfillDriver(h.deps).run({ dryRun: true, limit: 2 });
    expect(res.projection).toEqual({ wouldDistill: 2, wouldStageApply: 1 });
  });

  it("runs scan → distill → staging apply and marks each applied session", async () => {
    const distilled = [revision({ id: 10, payloadId: 110 }), revision({ id: 11, payloadId: 111 })];
    const h = harness({ distilled });
    const driver = new BackfillDriver(h.deps);

    const res = await driver.run({});

    expect(h.scan).toHaveBeenCalledOnce();
    expect(h.runTick).toHaveBeenCalledWith({ limit: undefined });
    expect(h.stageRun).toHaveBeenCalledTimes(2);
    expect(res.stageApply?.applied).toBe(2);
    expect(res.stageApply?.failed).toBe(0);
    expect(h.markTargetApplied).toHaveBeenCalledWith(10, "staging");
    expect(h.markTargetApplied).toHaveBeenCalledWith(11, "staging");
  });

  it("skips sessions already staged (idempotent resume)", async () => {
    const distilled = [
      revision({ id: 10, stagingAppliedAt: "2026-06-02T00:00:00Z" }),
      revision({ id: 11, stagingAppliedAt: null, payloadId: 111 }),
    ];
    const h = harness({ distilled });
    const res = await new BackfillDriver(h.deps).run({});

    expect(h.stageRun).toHaveBeenCalledTimes(1);
    expect(res.stageApply?.applied).toBe(1);
    expect(res.stageApply?.skipped).toBe(1);
    expect(h.markTargetApplied).not.toHaveBeenCalledWith(10, "staging");
  });

  it("caps staging apply at --limit new applies", async () => {
    const distilled = [revision({ id: 10 }), revision({ id: 11 }), revision({ id: 12 })];
    const h = harness({ distilled });
    const res = await new BackfillDriver(h.deps).run({ limit: 2 });

    expect(h.stageRun).toHaveBeenCalledTimes(2);
    expect(res.stageApply?.applied).toBe(2);
  });

  it("aggregates production leak and counts failures without marking them", async () => {
    const distilled = [revision({ id: 10 }), revision({ id: 11 })];
    const h = harness({
      distilled,
      stageOutcome: (payloadId) =>
        payloadId === payload(10).id
          ? shadowOutcome({ payloadId, productionLeak: 0 })
          : shadowOutcome({
              payloadId,
              productionLeak: 3,
              apply: {
                attemptId: 2,
                status: "dead_letter",
                target: "staging",
                applied: [],
                retried: true,
                replay: false,
              },
            }),
    });
    const res = await new BackfillDriver(h.deps).run({});

    expect(res.stageApply?.applied).toBe(1);
    expect(res.stageApply?.failed).toBe(1);
    expect(res.stageApply?.productionLeak).toBe(3);
    // The failed (dead_letter) session is NOT marked staged, so a re-run retries it.
    expect(h.markTargetApplied).toHaveBeenCalledTimes(1);
  });
});
