import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../extractors/providers/types.js";
import { mapReduceDistill, normalizeReducePayload, SegmentSummarySchema } from "./map-reduce.js";
import { assignMsgIds } from "./msg-id.js";
import { segmentMessages } from "./segmenter.js";

describe("normalizeReducePayload", () => {
  it("coerces msg-id string evidence into {start,end} point ranges", () => {
    const out = normalizeReducePayload({
      signals: [{ type: "task", evidence: ["msg-1", "msg-6"] }],
    }) as { signals: Array<{ evidence: unknown }> };
    expect(out.signals[0].evidence).toEqual([
      { start: "msg-1", end: "msg-1" },
      { start: "msg-6", end: "msg-6" },
    ]);
  });

  it("coerces a [start,end] tuple into a range object", () => {
    const out = normalizeReducePayload({
      signals: [{ evidence: [["msg-2", "msg-9"]] }],
    }) as { signals: Array<{ evidence: unknown }> };
    expect(out.signals[0].evidence).toEqual([{ start: "msg-2", end: "msg-9" }]);
  });

  it("passes through already-correct {start,end} objects", () => {
    const ev = [{ start: "msg-1", end: "msg-3" }];
    const out = normalizeReducePayload({ signals: [{ evidence: ev }] }) as {
      signals: Array<{ evidence: unknown }>;
    };
    expect(out.signals[0].evidence).toEqual(ev);
  });

  it("leaves non-object / signal-less input untouched", () => {
    expect(normalizeReducePayload(null)).toBeNull();
    expect(normalizeReducePayload({ foo: 1 })).toEqual({ foo: 1 });
  });
});

/**
 * A scripted LLM provider that returns a queued response per call, and records
 * the prompts it was given so we can assert carry-forward propagation.
 */
function scriptedProvider(responses: string[]): { provider: LLMProvider; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const provider: LLMProvider = {
    async chat(messages) {
      prompts.push(messages.map((m) => m.content).join("\n"));
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r;
    },
  };
  return { provider, prompts };
}

describe("SegmentSummarySchema", () => {
  it("validates the intermediate map schema", () => {
    const good = {
      seg_no: 1,
      summary: "discussed tooling",
      tentative_signals: [],
      overturned: [],
      carry_forward: "still deciding on bun",
    };
    expect(() => SegmentSummarySchema.parse(good)).not.toThrow();
  });
});

describe("mapReduceDistill — sequential map with carry-forward", () => {
  it("runs map segments in order and threads carry_forward into the next prompt", async () => {
    const parsed = assignMsgIds([
      { role: "user", content: "a".repeat(100) },
      { role: "user", content: "b".repeat(100) },
    ]);
    const segs = segmentMessages(parsed, { maxSegmentTokens: 30 }); // 2 segments

    const mapResponses = [
      JSON.stringify({
        seg_no: 1,
        summary: "seg1",
        tentative_signals: [],
        overturned: [],
        carry_forward: "CARRY_ONE",
      }),
      JSON.stringify({
        seg_no: 2,
        summary: "seg2",
        tentative_signals: [],
        overturned: [],
        carry_forward: "",
      }),
    ];
    const reduceResponse = JSON.stringify({ signals: [] });
    const { provider, prompts } = scriptedProvider([...mapResponses, reduceResponse]);

    await mapReduceDistill(segs, provider);

    // 2 map calls + 1 reduce call.
    expect(prompts.length).toBe(3);
    // The second map prompt must include the first segment's carry_forward.
    expect(prompts[1]).toContain("CARRY_ONE");
    // The first map prompt must NOT (nothing to carry yet).
    expect(prompts[0]).not.toContain("CARRY_ONE");
  });

  it("excludes overturned conclusions from the final reduced signals", async () => {
    const parsed = assignMsgIds([
      { role: "user", content: "a".repeat(100) },
      { role: "user", content: "b".repeat(100) },
    ]);
    const segs = segmentMessages(parsed, { maxSegmentTokens: 30 });

    const validSignal = {
      type: "decision",
      topic: "Adopt Bun",
      what: "use bun",
      entities: [],
      authority: "user_confirmed",
      evidence: [{ start: "msg-1", end: "msg-1" }],
      persistence_reason: "durable",
    };

    const mapResponses = [
      JSON.stringify({
        seg_no: 1,
        summary: "s1",
        tentative_signals: [validSignal, { topic: "Use Deno" }],
        overturned: [],
        carry_forward: "",
      }),
      JSON.stringify({
        seg_no: 2,
        summary: "s2",
        tentative_signals: [],
        // Seg 2 overturns the "Use Deno" tentative conclusion.
        overturned: [{ topic: "Use Deno", reason: "team rejected" }],
        carry_forward: "",
      }),
    ];
    // The reduce step returns final signals; the harness passes overturned topics
    // so the reducer/consumer can assert they were filtered. Here the reduce
    // response echoes only the surviving signal.
    const reduceResponse = JSON.stringify({ signals: [validSignal] });
    const { provider, prompts } = scriptedProvider([...mapResponses, reduceResponse]);

    const result = await mapReduceDistill(segs, provider);

    // The overturned topic set is surfaced and excludes nothing extra here.
    expect(result.overturnedTopics).toContain("Use Deno");
    // The reduce prompt carries an explicit instruction to drop overturned topics.
    const reducePrompt = prompts[prompts.length - 1];
    expect(reducePrompt.toLowerCase()).toContain("overturn");
    expect(reducePrompt).toContain("Use Deno");
    // Final payload excludes any signal whose topic was overturned.
    expect(result.payload.signals.every((s) => s.topic !== "Use Deno")).toBe(true);
    expect(result.payload.signals.some((s) => s.topic === "Adopt Bun")).toBe(true);
  });

  it("post-filters overturned topics even if the reducer leaks them back in", async () => {
    const parsed = assignMsgIds([{ role: "user", content: "a".repeat(100) }]);
    const segs = segmentMessages(parsed, { maxSegmentTokens: 30 });

    const leaked = {
      type: "decision",
      topic: "Use Deno",
      what: "x",
      entities: [],
      authority: "user_confirmed",
      evidence: [{ start: "msg-1", end: "msg-1" }],
      persistence_reason: "r",
    };
    const mapResponses = [
      JSON.stringify({
        seg_no: 1,
        summary: "s",
        tentative_signals: [],
        overturned: [{ topic: "Use Deno", reason: "rejected" }],
        carry_forward: "",
      }),
    ];
    // Reducer wrongly re-includes the overturned signal.
    const reduceResponse = JSON.stringify({ signals: [leaked] });
    const { provider } = scriptedProvider([...mapResponses, reduceResponse]);

    const result = await mapReduceDistill(segs, provider);
    // Belt-and-suspenders: the overturned topic is filtered out programmatically.
    expect(result.payload.signals.length).toBe(0);
  });
});
