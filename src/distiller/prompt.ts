/**
 * Distillation prompt assembly (spec §5, §5.1, §11 task 2.9).
 *
 * The judgment-declaration criteria live in an embedded markdown prompt
 * (`src/extractors/prompts/distill.md`, inlined by gen:assets into PROMPTS).
 * This module wraps that criteria into the concrete map + reduce prompts, with
 * carry-forward and overturned instructions threaded in.
 *
 * Keeping prompt text out of map-reduce.ts lets the criteria be iterated
 * (PR-1 eval loop) without touching orchestration logic.
 */

import { PROMPTS } from "../embedded-assets.generated.js";
import type { SegmentSummary } from "./map-reduce.js";

/** Load the embedded distill criteria; falls back to a terse built-in if absent. */
export function getDistillCriteria(): string {
  return PROMPTS["distill.md"] ?? FALLBACK_CRITERIA;
}

const FALLBACK_CRITERIA = `You are distilling an agent session for a future retriever 30 days from now.
Record only what a colleague would need to reconstruct WHY things are the way they
are. Distinguish: the user deciding (user_confirmed) vs. you proposing
(assistant_proposed) vs. a claim proven by a tool result (assistant_claimed).
Skip transient debugging chatter and unconfirmed proposals.`;

/**
 * Compact machine-checkable contract shown to the model (spec §5). Without this
 * the model only guesses common fields and drops per-type required fields
 * (preference.subject/category, reference.url, task.status, …) and the evidence
 * shape — every one of which is a hard Zod-validation failure. Keeping the exact
 * enum values + per-type fields inline is a correctness requirement, not tuning.
 */
export const SIGNAL_CONTRACT = `Each signal MUST match this schema exactly.
Common fields (ALL signals):
- type: one of "decision" | "task" | "reference" | "preference" | "knowledge" | "discovery"
- topic: short stable title
- what: the fact/decision itself
- why: motivation (optional)
- project: project name (optional)
- entities: array of entity name strings (may be empty)
- authority: "user_confirmed" (user decided/confirmed) | "assistant_proposed" (you proposed, unconfirmed) | "assistant_claimed" (you assert, e.g. from a tool result)
- evidence: NON-EMPTY array of msg-id ranges, each an OBJECT {"start":"msg-N","end":"msg-M"} — only reference msg-ids shown in the messages; never invent ids or line numbers
- persistence_reason: why this is worth remembering in 30 days
Per-type REQUIRED extra fields:
- decision: (no extra fields)
- task: status one of "open" | "in_progress" | "done" | "cancelled"; owner (optional); due_date (optional, ISO 8601 date-time)
- reference: url (REQUIRED — the url string MUST appear verbatim in the cited evidence messages); trigger (optional)
- preference: subject (REQUIRED); category one of "tooling" | "workflow" | "communication" | "coding_style" | "ui" | "personal" | "other"
- knowledge: source_kind one of "documentation" | "experiment" | "external_reference" | "domain_fact" | "observation"; valid_at / invalid_at (optional, ISO 8601)
- discovery: subtype one of "insight" | "pattern" | "risk" | "procedure"`;

export interface MapPromptInput {
  criteria?: string;
  segmentText: string;
  segNo: number;
  carryForward: string;
}

export function getMapPrompt(input: MapPromptInput): string {
  const criteria = input.criteria ?? getDistillCriteria();
  const carrySection =
    input.carryForward.trim().length > 0
      ? `\n## Carried forward from the previous segment\n\n${input.carryForward}\n`
      : "";
  return `${criteria}

## Segment ${input.segNo}
${carrySection}
## Messages

${input.segmentText}

## Signal contract

${SIGNAL_CONTRACT}

## Instructions

Distill THIS segment only. Output ONLY JSON of shape:
{
  "seg_no": ${input.segNo},
  "summary": "<one-paragraph gist of this segment>",
  "tentative_signals": [ /* candidate signals matching the contract above */ ],
  "overturned": [ { "topic": "<a topic from earlier that is now retracted>", "reason": "..." } ],
  "carry_forward": "<in-progress topics / undecided items to hand to the next segment>"
}`;
}

export interface ReducePromptInput {
  criteria?: string;
  segmentSummaries: SegmentSummary[];
  overturnedTopics: string[];
}

export function getReducePrompt(input: ReducePromptInput): string {
  const criteria = input.criteria ?? getDistillCriteria();
  const summariesJson = JSON.stringify(input.segmentSummaries, null, 2);
  const overturnedList =
    input.overturnedTopics.length > 0
      ? input.overturnedTopics.map((t) => `- ${t}`).join("\n")
      : "(none)";
  return `${criteria}

## Segment summaries

${summariesJson}

## Overturned topics (MUST NOT appear in the final signals)

${overturnedList}

## Signal contract

${SIGNAL_CONTRACT}

## Instructions

Merge the tentative signals across all segments into the final session payload.
RULE: any conclusion that appears in the overturned list above MUST NOT enter the
final signals. Deduplicate: no two final signals may share the same (type, topic).
Output ONLY JSON of shape { "signals": [ ...signals matching the contract above... ] }.`;
}
