// src/core/llm-json.ts
//
// Fence-tolerant JSON extraction for LLM responses. The production model
// (MiniMax-M2.5-highspeed, D4) wraps JSON in markdown code fences (```json …```)
// even when asked for raw JSON, so a bare JSON.parse throws on the leading
// backtick. This helper strips fences and, as a fallback, slices the outer
// {...} / [...] out of chatty output.
//
// Shared so the distiller (map-reduce) and the apply candidate decider parse the
// same way. (signal-extractor.ts predates this and keeps its own battle-tested
// copy; unifying it is a separate follow-up.)

/** Return the JSON text embedded in an LLM response, or null if none is found. */
export function extractJsonText(raw: string): string | null {
  let s = raw.trim();
  // Strip a leading ```json / ``` fence and a trailing ``` fence.
  s = s.replace(/^`{3,}(?:json|JSON)?\s*\n?/, "");
  s = s.replace(/\n?\s*`{3,}\s*$/, "");
  s = s.trim();
  if (!s) return null;

  // Fast path: already valid JSON.
  try {
    JSON.parse(s);
    return s;
  } catch {
    // fall through to bracket slicing
  }

  // Fallback: slice from the first opening bracket to its matching close.
  const firstBrace = s.indexOf("{");
  const firstBracket = s.indexOf("[");
  const start =
    firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? firstBrace : firstBracket;
  if (start < 0) return null;

  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse an LLM response as JSON, tolerating code fences / surrounding prose.
 * Throws if no JSON object/array can be recovered (callers treat that as a
 * validation failure and retry).
 */
export function parseLlmJson<T = unknown>(raw: string): T {
  const text = extractJsonText(raw);
  if (text === null) {
    throw new Error(`no JSON found in LLM response: ${raw.slice(0, 120)}`);
  }
  return JSON.parse(text) as T;
}
