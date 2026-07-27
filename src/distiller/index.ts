/**
 * SessionDistiller — orchestration (spec §4, §5, §11 PR-2).
 *
 * Ties the ledger → distill → outbox flow together, with the HARD PR-2 boundary
 * that NOTHING is applied and NO page is written. Per tick:
 *
 *   1. Pick up pending revisions (discovered, or retrying whose backoff elapsed).
 *   2. Silence gate: only distill sessions idle ≥ silence window (default 30 min).
 *   3. Stale guard: the ledger revision's content_hash must still match the file
 *      (a torn/updated snapshot is left for a later tick).
 *   4. Replay guard: if a payload already exists for the revision, never call the
 *      LLM — just ensure the ledger is linked/advanced.
 *   5. Distill: pre-LLM raw privacy → segment → sequential map-reduce → evidence
 *      validation → second-pass payload privacy → persist to outbox → distilled.
 *   6. On invalid output: retry ONCE in-tick; still bad → retrying (+ retry_count),
 *      or dead_letter once retries are exhausted.
 *
 * The orchestrator reads transcripts through an injectable TranscriptSource so it
 * is testable with in-memory content and independent of the collector's file IO.
 */

import { createHash } from "node:crypto";
import type { PrivacyConfig } from "../core/config.js";
import type { LLMProvider } from "../extractors/providers/types.js";
import type { AgentSessionStore, SessionRevision, SessionState } from "../store/agent-sessions.js";
import type { DistilledPayloadStore } from "../store/distilled-payload.js";
import { mapReduceDistill } from "./map-reduce.js";
import { assignMsgIds, type RawInputMessage, validateEvidence } from "./msg-id.js";
import { redactPayload } from "./payload-privacy.js";
import { RawMessagePrivacyProcessor } from "./raw-privacy.js";
import { segmentMessages } from "./segmenter.js";

/** A source of transcript content, keyed by (sourceInstance, sessionId). */
export interface TranscriptSource {
  load(
    sourceInstance: string,
    sessionId: string,
  ): Promise<{ content: string; mtimeMs: number } | null>;
}

export interface DistillerOpts {
  /** Silence window before a session is eligible for its first distillation. */
  silenceMs?: number;
  /** Max retries before dead-lettering a revision. */
  maxRetries?: number;
  /** Backoff before a retrying revision is retried. */
  retryBackoffMs?: number;
  /** Segment token budget for map-reduce. */
  maxSegmentTokens?: number;
  /** Injectable clock (ms). */
  now?: () => number;
}

/** Parses raw transcript content into ordered messages for a given source. */
export type TranscriptParser = (content: string, sourceInstance: string) => RawInputMessage[];

export interface SessionDistillerDeps {
  sessions: AgentSessionStore;
  payloads: DistilledPayloadStore;
  provider: LLMProvider;
  privacy: PrivacyConfig;
  transcripts: TranscriptSource;
  /**
   * Override how raw transcript content is parsed into messages. Defaults to the
   * claude-code JSONL shape; the historical backfill supplies a platform-aware
   * parser so codex (and other) formats distill correctly.
   */
  parse?: TranscriptParser;
  opts?: DistillerOpts;
}

export interface TickResult {
  considered: number;
  distilled: number;
  skipped: number;
  failed: number;
  deadLettered: number;
  replayed: number;
}

const DEFAULTS = {
  silenceMs: 30 * 60_000,
  maxRetries: 3,
  retryBackoffMs: 5 * 60_000,
  maxSegmentTokens: 3000,
};

export class SessionDistiller {
  private readonly now: () => number;
  private readonly parse: TranscriptParser;

  constructor(private readonly deps: SessionDistillerDeps) {
    this.now = deps.opts?.now ?? (() => Date.now());
    this.parse = deps.parse ?? ((content) => parseTranscript(content));
  }

  private opt<K extends keyof typeof DEFAULTS>(key: K): number {
    const v = this.deps.opts?.[key as keyof DistillerOpts];
    return typeof v === "number" ? v : DEFAULTS[key];
  }

  /**
   * Process one tick over pending revisions.
   *
   * `opts.limit` caps how many pending revisions are considered this tick — the
   * cost lever for backfill: process a small batch first before burning LLM on
   * the full historical backlog (spec §11 押后 backfill / task cost-awareness).
   */
  async runTick(opts?: { limit?: number }): Promise<TickResult> {
    const result: TickResult = {
      considered: 0,
      distilled: 0,
      skipped: 0,
      failed: 0,
      deadLettered: 0,
      replayed: 0,
    };

    let pending = [
      ...(await this.deps.sessions.listSessions({ state: "discovered" })),
      ...(await this.deps.sessions.listSessions({ state: "retrying" })),
    ];
    if (opts?.limit != null && opts.limit >= 0) {
      pending = pending.slice(0, opts.limit);
    }

    for (const rev of pending) {
      result.considered++;
      await this.processRevision(rev, result);
    }
    return result;
  }

  private async processRevision(rev: SessionRevision, result: TickResult): Promise<void> {
    // Replay guard: a payload already exists → never call the LLM again.
    const existing = await this.deps.payloads.getByRevision(rev.id);
    if (existing) {
      result.replayed++;
      if (rev.state === "discovered") {
        await this.safeMark(rev.id, "distilled");
      }
      return;
    }

    const file = await this.deps.transcripts.load(rev.sourceInstance, rev.sessionId);
    if (!file) {
      result.skipped++;
      return;
    }

    // Silence gate.
    if (this.now() - file.mtimeMs < this.opt("silenceMs")) {
      result.skipped++;
      return;
    }

    // Stale guard: the ledger revision must match the current file content.
    const currentHash = createHash("sha256").update(file.content).digest("hex");
    if (currentHash !== rev.contentHash) {
      result.skipped++;
      return;
    }

    // Retry backoff: a retrying revision waits before its next attempt.
    if (rev.state === "retrying") {
      const since = Date.parse(rev.updatedAt);
      if (Number.isFinite(since) && this.now() - since < this.opt("retryBackoffMs")) {
        result.skipped++;
        return;
      }
    }

    const messages = this.parse(file.content, rev.sourceInstance);
    if (messages.length === 0) {
      result.skipped++;
      return;
    }

    const outcome = await this.distillOnce(messages);
    if (outcome.ok) {
      // Second-pass privacy + persist to outbox.
      const clean = redactPayload(outcome.payload, this.deps.privacy);
      await this.deps.payloads.persist({
        sourceInstance: rev.sourceInstance,
        sessionId: rev.sessionId,
        revisionId: rev.id,
        contentHash: rev.contentHash,
        payload: clean,
        restorationMap: outcome.restorationMap,
      });
      // persist() advances discovered→distilled; a retrying revision needs an
      // explicit transition back to distilled.
      if (rev.state === "retrying") {
        await this.safeMark(rev.id, "distilled");
      }
      result.distilled++;
      return;
    }

    // Failure path: retry / dead-letter.
    await this.handleFailure(rev, result);
  }

  /**
   * Run the distill pipeline once with a single in-tick retry. Returns the
   * validated payload + reversible restoration map, or a failure.
   */
  private async distillOnce(messages: RawInputMessage[]): Promise<
    | {
        ok: true;
        payload: import("./contract.js").DistilledPayload;
        restorationMap: import("./raw-privacy.js").RestorationMap;
      }
    | { ok: false }
  > {
    const parsed = assignMsgIds(messages);

    // First pass: redact raw text BEFORE the LLM sees it.
    const rawPrivacy = new RawMessagePrivacyProcessor(this.deps.privacy);
    const { messages: redacted, restorationMap } = rawPrivacy.redactMessages(parsed);

    const segments = segmentMessages(redacted, {
      maxSegmentTokens: this.opt("maxSegmentTokens"),
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { payload } = await mapReduceDistill(segments, this.deps.provider);
        // Evidence bounds + reference.url locatability against the (redacted)
        // messages actually shown to the model.
        const ev = validateEvidence(payload.signals, redacted);
        if (!ev.ok) continue;
        return { ok: true, payload, restorationMap };
      } catch {
        // fall through to retry / failure
      }
    }
    return { ok: false };
  }

  private async handleFailure(rev: SessionRevision, result: TickResult): Promise<void> {
    if (rev.state === "retrying") {
      // Already retrying: dead-letter once retries are exhausted, else bump count.
      if (rev.retryCount >= this.opt("maxRetries")) {
        await this.safeMark(rev.id, "dead_letter");
        result.deadLettered++;
      } else {
        await this.deps.sessions.incrementRetry(rev.id);
        result.failed++;
      }
      return;
    }
    // First failure for a discovered revision → retrying (+1).
    await this.safeMark(rev.id, "retrying");
    await this.deps.sessions.incrementRetry(rev.id);
    result.failed++;
  }

  private async safeMark(id: number, next: SessionState): Promise<void> {
    try {
      await this.deps.sessions.markState(id, next);
    } catch {
      // Illegal transition (already advanced by a concurrent tick) — ignore.
    }
  }
}

/**
 * Parse a claude-code / codex-style JSONL transcript into ordered role+text
 * messages. Tolerant: skips non-conversation lines and unparseable content.
 * Kept local so the distiller does not depend on the collector's file IO.
 */
export function parseTranscript(content: string): RawInputMessage[] {
  const out: RawInputMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = obj.type;
    if (type !== "user" && type !== "assistant") continue;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    let text: string;
    const content = message.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text ?? "")
        .join("\n\n");
    } else {
      continue;
    }
    if (!text.trim()) continue;
    out.push({ role, content: text });
  }
  return out;
}
