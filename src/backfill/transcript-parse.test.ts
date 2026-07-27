// src/backfill/transcript-parse.test.ts

import { describe, expect, it } from "vitest";
import { ClaudeCodeParser, CodexParser } from "../collectors/agent/index.js";
import { backfillTranscriptParser, parseWithSessionParser } from "./transcript-parse.js";

let seq = 0;
const claudeLine = (role: string, text: string) =>
  JSON.stringify({
    type: role,
    uuid: `u${seq++}`,
    timestamp: "2026-05-23T09:03:46Z",
    message: { role, content: text },
  });

const codexMeta = JSON.stringify({
  type: "session_meta",
  payload: { id: "sess-x", timestamp: "2026-05-23T09:03:46Z" },
});
const codexUser = JSON.stringify({
  type: "response_item",
  payload: { role: "user", content: [{ type: "input_text", text: "hello from user" }] },
});
const codexAssistant = JSON.stringify({
  type: "response_item",
  payload: { role: "assistant", content: [{ type: "output_text", text: "hi from assistant" }] },
});

describe("parseWithSessionParser", () => {
  it("parses claude-code JSONL into ordered role+text messages", () => {
    const content = [claudeLine("user", "q1"), claudeLine("assistant", "a1")].join("\n");
    const msgs = parseWithSessionParser(content, new ClaudeCodeParser());
    expect(msgs).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("parses codex rollout records (the format the built-in parser misses)", () => {
    const content = [codexMeta, codexUser, codexAssistant].join("\n");
    const msgs = parseWithSessionParser(content, new CodexParser());
    expect(msgs).toEqual([
      { role: "user", content: "hello from user" },
      { role: "assistant", content: "hi from assistant" },
    ]);
  });
});

describe("backfillTranscriptParser", () => {
  it("dispatches on sourceInstance", () => {
    const parse = backfillTranscriptParser();
    expect(parse([codexMeta, codexUser].join("\n"), "codex")).toEqual([
      { role: "user", content: "hello from user" },
    ]);
    expect(parse(claudeLine("user", "hey"), "claude-code")).toEqual([
      { role: "user", content: "hey" },
    ]);
  });
});
