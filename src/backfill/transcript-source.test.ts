// src/backfill/transcript-source.test.ts

import { describe, expect, it, vi } from "vitest";
import type { SessionLayout } from "../collectors/agent/types.js";
import { LayoutTranscriptSource, type TranscriptFs } from "./transcript-source.js";

function layout(baseDir: string): SessionLayout {
  return {
    baseDir,
    glob: "*/*.jsonl",
    sessionIdFromPath: (p) => p.split("/").pop()?.replace(".jsonl", "") ?? "",
    channelFromPath: (_p, s) => s,
  };
}

function fakeFs(files: Record<string, { content: string; mtimeMs: number }>): {
  fs: TranscriptFs;
  glob: ReturnType<typeof vi.fn>;
} {
  const glob = vi.fn(async () => Object.keys(files));
  const fs: TranscriptFs = {
    glob,
    stat: async (p) => {
      if (!files[p]) throw new Error("ENOENT");
      return { mtimeMs: files[p].mtimeMs };
    },
    readFile: async (p) => {
      if (!files[p]) throw new Error("ENOENT");
      return files[p].content;
    },
  };
  return { fs, glob };
}

describe("LayoutTranscriptSource", () => {
  it("resolves a session by id and returns content + mtime", async () => {
    const { fs } = fakeFs({
      "/base/proj/sess-1.jsonl": { content: "line1\nline2", mtimeMs: 111 },
    });
    const src = new LayoutTranscriptSource({ "claude-code": layout("/base") }, fs);
    const out = await src.load("claude-code", "sess-1");
    expect(out).toEqual({ content: "line1\nline2", mtimeMs: 111 });
  });

  it("returns null for an unknown source instance", async () => {
    const { fs } = fakeFs({});
    const src = new LayoutTranscriptSource({ "claude-code": layout("/base") }, fs);
    expect(await src.load("codex", "sess-1")).toBeNull();
  });

  it("returns null for a session not on disk", async () => {
    const { fs } = fakeFs({ "/base/proj/sess-1.jsonl": { content: "x", mtimeMs: 1 } });
    const src = new LayoutTranscriptSource({ "claude-code": layout("/base") }, fs);
    expect(await src.load("claude-code", "missing")).toBeNull();
  });

  it("builds the file index only once per source (cached)", async () => {
    const { fs, glob } = fakeFs({ "/base/proj/sess-1.jsonl": { content: "x", mtimeMs: 1 } });
    const src = new LayoutTranscriptSource({ "claude-code": layout("/base") }, fs);
    await src.load("claude-code", "sess-1");
    await src.load("claude-code", "sess-1");
    expect(glob).toHaveBeenCalledOnce();
  });
});
