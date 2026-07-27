// src/backfill/driver.ts
//
// BackfillDriver — the historical backfill ORCHESTRATION layer (spec §11 押后
// backfill). It does NOT re-implement any engine logic; it strings together the
// already-merged parts of the extraction-quality-redesign:
//
//   1. scan   → AgentSessionScanner records historical JSONL into the ledger
//               (state=discovered), idempotently.
//   2. distill→ SessionDistiller (PR-2) turns discovered revisions into immutable
//               distilled_payload rows (state=distilled). Replay-safe: an existing
//               payload is never re-distilled (no LLM).
//   3. apply  → ShadowRunner (PR-6) applies each payload to the physically
//               isolated `staging` schema with the single PR-4 apply engine
//               (target=staging), proving zero production pollution.
//
// Resumable + idempotent by construction: the ledger state machine + the
// per-target `staging_applied_at` marker mean a re-run skips already-applied
// sessions and never double-writes. `--limit` caps every stage (cost lever),
// `--since` filters the scan window, `--dry-run` scans + reports without spending
// any LLM tokens.
//
// Every collaborator is an interface so the orchestration is unit-tested with
// mocks (no DB, no LLM) — see driver.test.ts.

import type { ShadowRunOutcome } from "../apply/shadow-runner.js";
import type { ScanResult } from "../core/agent-session-scanner.js";
import type { TickResult } from "../distiller/index.js";
import type { SessionRevision, SessionState } from "../store/agent-sessions.js";
import type { StoredPayload } from "../store/distilled-payload.js";

/** Aggregate of the per-source scan pass. */
export interface ScanSummary {
  perSource: Record<string, ScanResult>;
  scanned: number;
  discovered: number;
  revised: number;
  skipped: number;
}

/** One source's scan, driven by the driver's scan step. */
export interface ScanStep {
  /** Scan every configured source; `sinceMs` filters files older than the window. */
  scan(sinceMs?: number): Promise<ScanSummary>;
}

export interface DistillStep {
  runTick(opts?: { limit?: number }): Promise<TickResult>;
}

export interface StageApplyStep {
  run(payloadId: number): Promise<ShadowRunOutcome>;
}

/** The subset of AgentSessionStore the driver needs. */
export interface SessionLedger {
  listSessions(opts?: {
    sourceInstance?: string;
    state?: SessionState;
  }): Promise<SessionRevision[]>;
  markTargetApplied(id: number, target: "staging" | "production"): Promise<void>;
}

/** The subset of DistilledPayloadStore the driver needs. */
export interface PayloadLookup {
  getByRevision(revisionId: number): Promise<StoredPayload | null>;
}

export interface BackfillDriverDeps {
  scanStep: ScanStep;
  distiller: DistillStep;
  stageApplier: StageApplyStep;
  ledger: SessionLedger;
  payloads: PayloadLookup;
}

export interface BackfillOptions {
  /** Cap sessions processed at each stage. Omit for the full backlog. */
  limit?: number;
  /** Scan-only: record discovered + report projected work; no distill, no LLM. */
  dryRun?: boolean;
  /** Only scan files with mtime ≥ this (ms). */
  sinceMs?: number;
}

export interface StageApplyRecord {
  revisionId: number;
  payloadId: number;
  planId: number;
  status: ShadowRunOutcome["apply"]["status"];
  productionLeak: number;
}

export interface StageApplySummary {
  applied: number;
  failed: number;
  skipped: number;
  /** Net production rows written across all applies — MUST be 0 (physical isolation). */
  productionLeak: number;
  records: StageApplyRecord[];
}

export interface BackfillResult {
  dryRun: boolean;
  scan: ScanSummary;
  /** Projected work when dryRun; null otherwise. */
  projection: { wouldDistill: number; wouldStageApply: number } | null;
  /** Distillation tick result; null when dryRun. */
  distill: TickResult | null;
  /** Staging apply summary; null when dryRun. */
  stageApply: StageApplySummary | null;
}

export class BackfillDriver {
  constructor(private readonly deps: BackfillDriverDeps) {}

  async run(opts: BackfillOptions = {}): Promise<BackfillResult> {
    const scan = await this.deps.scanStep.scan(opts.sinceMs);

    if (opts.dryRun) {
      const discovered = await this.deps.ledger.listSessions({ state: "discovered" });
      const distilled = await this.deps.ledger.listSessions({ state: "distilled" });
      const pendingApply = distilled.filter((r) => !r.stagingAppliedAt);
      return {
        dryRun: true,
        scan,
        projection: {
          wouldDistill: cap(discovered.length, opts.limit),
          wouldStageApply: cap(pendingApply.length, opts.limit),
        },
        distill: null,
        stageApply: null,
      };
    }

    const distill = await this.deps.distiller.runTick({ limit: opts.limit });
    const stageApply = await this.stageApplyPending(opts.limit);

    return { dryRun: false, scan, projection: null, distill, stageApply };
  }

  /** Apply every distilled-but-not-yet-staged payload, up to `limit` new applies. */
  private async stageApplyPending(limit?: number): Promise<StageApplySummary> {
    const summary: StageApplySummary = {
      applied: 0,
      failed: 0,
      skipped: 0,
      productionLeak: 0,
      records: [],
    };

    const distilled = await this.deps.ledger.listSessions({ state: "distilled" });
    for (const rev of distilled) {
      if (limit != null && summary.applied + summary.failed >= limit) break;

      // Idempotent resume: a session already staged is skipped (no re-apply).
      if (rev.stagingAppliedAt) {
        summary.skipped++;
        continue;
      }
      const payload = await this.deps.payloads.getByRevision(rev.id);
      if (!payload) {
        summary.skipped++;
        continue;
      }

      const outcome = await this.deps.stageApplier.run(payload.id);
      summary.productionLeak += outcome.productionLeak;
      const applied = outcome.apply.status === "applied";
      if (applied) {
        await this.deps.ledger.markTargetApplied(rev.id, "staging");
        summary.applied++;
      } else {
        summary.failed++;
      }
      summary.records.push({
        revisionId: rev.id,
        payloadId: payload.id,
        planId: outcome.planId,
        status: outcome.apply.status,
        productionLeak: outcome.productionLeak,
      });
    }

    return summary;
  }
}

function cap(n: number, limit?: number): number {
  return limit != null ? Math.min(n, limit) : n;
}
