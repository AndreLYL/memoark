// src/backfill/candidate-decider.test.ts

import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "../apply/types.js";
import type { DistilledSignal } from "../distiller/contract.js";
import type { LLMProvider } from "../extractors/providers/types.js";
import { LLMCandidateDecider, parseDecision } from "./candidate-decider.js";

function signal(): DistilledSignal {
  return {
    type: "decision",
    topic: "Use Postgres",
    what: "Adopt Postgres as the store",
    why: "durability",
    entities: [],
    authority: "user_confirmed",
    evidence: [{ start: "m1", end: "m2" }],
    persistence_reason: "architecture decision",
  } as DistilledSignal;
}

function candidate(slug: string): Candidate {
  return {
    slug,
    title: slug,
    body: "body",
    updated_at: null,
    content_hash: "hash",
    project: null,
    contributions_summary: "",
  };
}

function provider(reply: string): { llm: LLMProvider; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async () => reply);
  return { llm: { chat }, chat };
}

describe("LLMCandidateDecider", () => {
  it("returns NEW without calling the LLM when the candidate pool is empty", async () => {
    const p = provider("{}");
    const dec = new LLMCandidateDecider(p.llm);
    const out = await dec.decide({ signal: signal(), candidates: [], target: "staging" });
    expect(out.action).toBe("NEW");
    expect(p.chat).not.toHaveBeenCalled();
  });

  it("calls the LLM when candidates exist and parses its decision", async () => {
    const p = provider(
      '{"action":"UPDATE","target_slug":"decisions/use-postgres","reason":"same"}',
    );
    const dec = new LLMCandidateDecider(p.llm);
    const out = await dec.decide({
      signal: signal(),
      candidates: [candidate("decisions/use-postgres")],
      target: "staging",
    });
    expect(p.chat).toHaveBeenCalledOnce();
    expect(out.action).toBe("UPDATE");
    expect(out.target_slug).toBe("decisions/use-postgres");
  });

  it("falls back to NEW when the LLM throws", async () => {
    const chat = vi.fn(async () => {
      throw new Error("boom");
    });
    const dec = new LLMCandidateDecider({ chat });
    const out = await dec.decide({
      signal: signal(),
      candidates: [candidate("x")],
      target: "staging",
    });
    expect(out.action).toBe("NEW");
    expect(out.reason).toContain("boom");
  });
});

describe("parseDecision", () => {
  it("parses fenced json", () => {
    const out = parseDecision('```json\n{"action":"LINK_EXISTING","target_slug":"a/b"}\n```');
    expect(out.action).toBe("LINK_EXISTING");
    expect(out.target_slug).toBe("a/b");
  });

  it("coerces unknown actions to NEW", () => {
    expect(parseDecision('{"action":"FROB"}').action).toBe("NEW");
  });

  it("returns NEW on unparseable input", () => {
    expect(parseDecision("not json at all").action).toBe("NEW");
  });

  it("normalizes empty target_slug to null", () => {
    expect(parseDecision('{"action":"NEW","target_slug":""}').target_slug).toBeNull();
  });
});
