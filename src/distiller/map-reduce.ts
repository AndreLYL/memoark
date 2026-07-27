/**
 * Sequential map-reduce distillation (spec §5.1).
 *
 * MAP (sequential, not parallel): each segment is distilled in order; the prompt
 * for segment N carries forward segment N-1's `carry_forward` (in-progress topics
 * / undecided items) so `overturned` can be filled reliably. Session counts are
 * low, so sequential cost is acceptable.
 *
 * Intermediate per-segment schema:
 *   { seg_no, summary, tentative_signals[], overturned[], carry_forward }
 *
 * REDUCE: merges the tentative signals into a final payload. The reduce prompt
 * carries the explicit rule "conclusions appearing in any `overturned` must not
 * enter the final signals". We additionally post-filter overturned topics
 * programmatically so a model slip cannot leak a retracted conclusion back in.
 *
 * The final payload is only structurally validated here (parsePayload). Evidence
 * bounds + reference.url locatability (msg-id.ts) and second-pass privacy run in
 * the orchestrator, which has the full transcript.
 */

import { z } from "zod";
import { parseLlmJson } from "../core/llm-json.js";
import type { LLMProvider } from "../extractors/providers/types.js";
import {
  type DistilledPayload,
  DistilledPayloadSchema,
  parsePayload,
  slugifyTopic,
} from "./contract.js";
import { getMapPrompt, getReducePrompt } from "./prompt.js";
import type { Segment } from "./segmenter.js";

// Intermediate map output. tentative_signals / overturned stay loose (z.unknown /
// partial) because a segment view is provisional — only the reduced payload is
// held to the strict contract.
export const OverturnedSchema = z.object({
  topic: z.string().min(1),
  reason: z.string().optional(),
});

export const SegmentSummarySchema = z.object({
  seg_no: z.number(),
  summary: z.string(),
  tentative_signals: z.array(z.record(z.unknown())),
  overturned: z.array(OverturnedSchema),
  carry_forward: z.string(),
});
export type SegmentSummary = z.infer<typeof SegmentSummarySchema>;

export interface MapReduceResult {
  payload: DistilledPayload;
  overturnedTopics: string[];
  segmentSummaries: SegmentSummary[];
}

function renderSegment(seg: Segment): string {
  return seg.messages
    .map((m) => {
      const cont = m.continued ? " (continued)" : "";
      return `[${m.msgId}${cont}] ${m.role}: ${m.content}`;
    })
    .join("\n");
}

/**
 * Run sequential map over segments then a single reduce.
 * `criteria` is the judgment-declaration prompt fragment (spec §5 / §11 task 2.9);
 * callers inject the embedded distill criteria.
 */
export async function mapReduceDistill(
  segments: Segment[],
  provider: LLMProvider,
  criteria?: string,
): Promise<MapReduceResult> {
  const summaries: SegmentSummary[] = [];
  let carry = "";

  for (const seg of segments) {
    const prompt = getMapPrompt({
      criteria,
      segmentText: renderSegment(seg),
      segNo: seg.segNo,
      carryForward: carry,
    });
    const raw = await provider.chat(
      [
        { role: "system", content: "You are a session distiller. Reply with JSON only." },
        { role: "user", content: prompt },
      ],
      { responseFormat: "json" },
    );
    const parsed = SegmentSummarySchema.parse(parseLlmJson(raw));
    summaries.push(parsed);
    carry = parsed.carry_forward;
  }

  const overturnedTopics = summaries.flatMap((s) => s.overturned.map((o) => o.topic));
  const overturnedSlugs = new Set(overturnedTopics.map(slugifyTopic));

  const reducePrompt = getReducePrompt({
    criteria,
    segmentSummaries: summaries,
    overturnedTopics,
  });
  const reduceRaw = await provider.chat(
    [
      { role: "system", content: "You are a session distiller. Reply with JSON only." },
      { role: "user", content: reducePrompt },
    ],
    { responseFormat: "json" },
  );

  const reduceParsed = DistilledPayloadSchema.parse(
    normalizeReducePayload(parseLlmJson(reduceRaw)),
  );

  // Belt-and-suspenders: strip any signal whose topic was overturned, even if the
  // reducer wrongly re-included it.
  const filtered = {
    signals: reduceParsed.signals.filter((s) => !overturnedSlugs.has(slugifyTopic(s.topic))),
  };
  const finalRes = parsePayload(filtered);
  if (!finalRes.ok) {
    throw new Error(`reduced payload failed validation: ${finalRes.error.message}`);
  }

  return { payload: finalRes.payload, overturnedTopics, segmentSummaries: summaries };
}

/**
 * Normalize a reduce payload's evidence into the `MsgRange` ({start,end}) shape
 * before strict validation. The mandated production model (MiniMax, D4) commonly
 * emits evidence as bare msg-id strings (`"evidence": ["msg-4","msg-5"]`) rather
 * than range objects; each string is coerced to a point range {start:s, end:s},
 * and an already-correct {start,end} object passes through untouched. This keeps
 * the strict contract (§5) intact while tolerating the real model's output — the
 * downstream `validateEvidence` still rejects any out-of-range msg-id.
 */
export function normalizeReducePayload(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const obj = input as { signals?: unknown };
  if (!Array.isArray(obj.signals)) return input;
  obj.signals = obj.signals.map((sig) => {
    if (!sig || typeof sig !== "object") return sig;
    const s = sig as { evidence?: unknown };
    if (Array.isArray(s.evidence)) {
      s.evidence = s.evidence.map((e) => {
        if (typeof e === "string") return { start: e, end: e };
        if (Array.isArray(e) && e.length >= 2) return { start: String(e[0]), end: String(e[1]) };
        if (Array.isArray(e) && e.length === 1) return { start: String(e[0]), end: String(e[0]) };
        return e;
      });
    }
    return s;
  });
  return obj;
}
