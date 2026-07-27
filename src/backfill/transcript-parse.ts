// src/backfill/transcript-parse.ts
//
// Platform-aware transcript parsing for the backfill distiller. The distiller's
// built-in parseTranscript only understands the claude-code JSONL shape; codex
// (and hermes) rollouts use an entirely different record layout. Rather than
// re-implement those, this reuses each source's existing SessionParser
// (ClaudeCodeParser / CodexParser) — the exact parser the live collector uses —
// and adapts its RawMessage output into the distiller's RawInputMessage.

import { ClaudeCodeParser, CodexParser } from "../collectors/agent/index.js";
import type { SessionParser } from "../collectors/agent/types.js";
import type { TranscriptParser } from "../distiller/index.js";
import type { RawInputMessage } from "../distiller/msg-id.js";

/** Parse one source's raw JSONL content into ordered role+text messages. */
export function parseWithSessionParser(content: string, parser: SessionParser): RawInputMessage[] {
  const out: RawInputMessage[] = [];
  const lines = content.split("\n");
  let sessionMeta: ReturnType<SessionParser["parseSessionMeta"]> = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const trimmed = lines[lineIndex].trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Capture session meta (first header record) so parsers that need it work.
    const meta = parser.parseSessionMeta(parsed);
    if (meta) {
      sessionMeta = meta;
      continue;
    }
    if (!parser.isConversationRecord(parsed)) continue;

    const msg = parser.parseRecord(parsed, {
      sessionId: sessionMeta?.sessionId ?? "",
      filePath: "",
      channel: "",
      lineIndex,
      sessionMeta,
    });
    if (!msg) continue;
    const text = msg.content?.trim();
    if (!text) continue;
    // Both agent parsers encode role via direction: user→"sent", assistant→"received".
    out.push({ role: msg.direction === "sent" ? "user" : "assistant", content: text });
  }
  return out;
}

/**
 * A TranscriptParser that dispatches on sourceInstance to the right platform
 * parser. Falls back to the claude-code parser for unknown sources.
 */
export function backfillTranscriptParser(): TranscriptParser {
  const parsers: Record<string, SessionParser> = {
    "claude-code": new ClaudeCodeParser(),
    codex: new CodexParser(),
  };
  return (content, sourceInstance) =>
    parseWithSessionParser(content, parsers[sourceInstance] ?? parsers["claude-code"]);
}
