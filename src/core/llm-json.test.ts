// src/core/llm-json.test.ts

import { describe, expect, it } from "vitest";
import { extractJsonText, parseLlmJson } from "./llm-json.js";

describe("extractJsonText", () => {
  it("passes through clean JSON", () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it("strips ```json code fences (the MiniMax shape that broke map-reduce)", () => {
    const raw = '```json\n{"seg_no":1,"summary":"x"}\n```';
    expect(JSON.parse(extractJsonText(raw) as string)).toEqual({ seg_no: 1, summary: "x" });
  });

  it("strips bare ``` fences", () => {
    expect(JSON.parse(extractJsonText("```\n[1,2,3]\n```") as string)).toEqual([1, 2, 3]);
  });

  it("slices JSON out of surrounding prose", () => {
    const raw = 'Sure, here is the result: {"action":"NEW"} — hope that helps!';
    expect(JSON.parse(extractJsonText(raw) as string)).toEqual({ action: "NEW" });
  });

  it("handles braces inside strings", () => {
    const raw = '{"text":"a } b"}';
    expect(extractJsonText(raw)).toBe(raw);
  });

  it("returns null when there is no JSON", () => {
    expect(extractJsonText("no json here")).toBeNull();
    expect(extractJsonText("")).toBeNull();
  });
});

describe("parseLlmJson", () => {
  it("parses fenced JSON into an object", () => {
    expect(parseLlmJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("throws when no JSON is recoverable", () => {
    expect(() => parseLlmJson("nope")).toThrow(/no JSON/);
  });
});
