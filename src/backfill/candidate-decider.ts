// src/backfill/candidate-decider.ts
//
// LLMCandidateDecider — the real (LLM-backed) restricted-upsert decider (spec
// §7). The apply engine's plan step (buildApplyPlan) delegates the per-signal
// NEW | UPDATE | SUPERSEDE | LINK_EXISTING | NOOP choice to a CandidateDecider;
// shadow-runner / cutover tests only ever supplied mocks, so this is the first
// production decider.
//
// Cost lever (important for backfill): when the candidate pool is EMPTY there is
// nothing to update/link/supersede, so the only valid action is NEW — we return
// it WITHOUT calling the LLM. On a fresh staging schema the pool starts empty and
// fills gradually, so the vast majority of the first backfill pass costs zero
// decision tokens; the LLM is consulted only once real collision candidates
// exist. buildApplyPlan still coerces any out-of-pool pick back to NEW, so a
// hallucinated slug can never point at an arbitrary page.

import type { CandidateDecider, CandidateDecision } from "../apply/candidate-selection.js";
import type { ApplyAction, ApplyTarget, Candidate } from "../apply/types.js";
import { extractJsonText } from "../core/llm-json.js";
import type { DistilledSignal } from "../distiller/contract.js";
import type { LLMProvider } from "../extractors/providers/types.js";

const VALID_ACTIONS: ReadonlySet<ApplyAction> = new Set<ApplyAction>([
  "NEW",
  "UPDATE",
  "SUPERSEDE",
  "LINK_EXISTING",
  "NOOP",
]);

const SYSTEM_PROMPT = `You are the restricted-upsert decision step of a personal-memory pipeline.
Given ONE distilled signal and up to five candidate memory pages, choose exactly one action:
- NEW: no candidate is the same fact — create a fresh page.
- UPDATE: a candidate is the same fact, now with more/updated detail — attach to it.
- SUPERSEDE: a candidate is an older conclusion this signal overturns — replace it.
- LINK_EXISTING: a candidate already fully captures this fact — just link, add nothing.
- NOOP: the signal is not worth persisting at all.
Rules:
- You may only reference a candidate by its exact "slug". Never invent a slug.
- Prefer NEW when unsure rather than merging into an unrelated page.
Respond with ONLY compact JSON: {"action": "...", "target_slug": "<slug or null>", "reason": "<short>"}.`;

export interface LLMCandidateDeciderOpts {
  /** Max tokens for the decision completion. */
  maxTokens?: number;
  temperature?: number;
}

export class LLMCandidateDecider implements CandidateDecider {
  constructor(
    private readonly provider: LLMProvider,
    private readonly opts: LLMCandidateDeciderOpts = {},
  ) {}

  async decide(input: {
    signal: DistilledSignal;
    candidates: Candidate[];
    target: ApplyTarget;
  }): Promise<CandidateDecision> {
    // No candidates → NEW is the only admissible action; skip the LLM entirely.
    if (input.candidates.length === 0) {
      return { action: "NEW", target_slug: null, reason: "no candidates (empty pool)" };
    }

    const userPrompt = buildUserPrompt(input.signal, input.candidates);
    let raw: string;
    try {
      raw = await this.provider.chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        {
          responseFormat: "json",
          temperature: this.opts.temperature ?? 0,
          maxTokens: this.opts.maxTokens ?? 256,
        },
      );
    } catch (err) {
      // LLM failure must not abort the whole backfill: fall back to NEW (safe —
      // never merges into an existing page on a transient error).
      const reason = err instanceof Error ? err.message : String(err);
      return { action: "NEW", target_slug: null, reason: `llm error: ${reason}` };
    }

    return parseDecision(raw);
  }
}

function buildUserPrompt(signal: DistilledSignal, candidates: Candidate[]): string {
  const sig = {
    type: signal.type,
    topic: signal.topic,
    what: signal.what,
    why: signal.why,
    authority: signal.authority,
  };
  const cands = candidates.map((c, i) => ({
    n: i + 1,
    slug: c.slug,
    title: c.title,
    project: c.project,
    body: c.body,
    contributions: c.contributions_summary,
  }));
  return `SIGNAL:\n${JSON.stringify(sig)}\n\nCANDIDATES:\n${JSON.stringify(cands)}`;
}

/** Parse the model's JSON decision, tolerating code fences and stray prose. */
export function parseDecision(raw: string): CandidateDecision {
  const json = extractJsonText(raw);
  if (!json) return { action: "NEW", target_slug: null, reason: "unparseable decision → NEW" };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { action: "NEW", target_slug: null, reason: "invalid json → NEW" };
  }

  const actionRaw = typeof obj.action === "string" ? obj.action.toUpperCase() : "";
  const action = VALID_ACTIONS.has(actionRaw as ApplyAction) ? (actionRaw as ApplyAction) : "NEW";
  const targetSlug =
    typeof obj.target_slug === "string" && obj.target_slug.length > 0 ? obj.target_slug : null;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { action, target_slug: targetSlug, reason };
}
