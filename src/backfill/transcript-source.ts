// src/backfill/transcript-source.ts
//
// LayoutTranscriptSource — a file-backed TranscriptSource for the historical
// backfill driver. The SessionDistiller (PR-2) reads transcripts through an
// injectable TranscriptSource keyed by (sourceInstance, sessionId); at daemon
// time that seam is fed by the live collector, but for backfill we resolve the
// transcript straight off disk via each source's SessionLayout.
//
// One layout per source instance (claude-code → ~/.claude/projects/**,
// codex → ~/.codex/sessions/**). The file index (sessionId → path) is built
// lazily on first load and cached; a session not on disk yields null so the
// distiller simply skips it (a dead-lettered / deleted session never blocks).

import * as fsp from "node:fs/promises";
import fg from "fast-glob";
import type { SessionLayout } from "../collectors/agent/types.js";
import type { TranscriptSource } from "../distiller/index.js";

/** Minimal fs surface, injectable for deterministic tests. */
export interface TranscriptFs {
  glob(
    pattern: string,
    opts: { cwd: string; absolute: boolean; onlyFiles: boolean },
  ): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  readFile(path: string, enc: "utf-8"): Promise<string>;
}

const defaultFs: TranscriptFs = {
  glob: (pattern, opts) => fg(pattern, opts),
  stat: (p) => fsp.stat(p),
  readFile: (p, enc) => fsp.readFile(p, enc),
};

export class LayoutTranscriptSource implements TranscriptSource {
  /** Per-source cached sessionId → filePath index. */
  private readonly indexes = new Map<string, Promise<Map<string, string>>>();

  constructor(
    private readonly layouts: Record<string, SessionLayout>,
    private readonly fs: TranscriptFs = defaultFs,
  ) {}

  async load(
    sourceInstance: string,
    sessionId: string,
  ): Promise<{ content: string; mtimeMs: number } | null> {
    const layout = this.layouts[sourceInstance];
    if (!layout) return null;

    const index = await this.indexFor(sourceInstance, layout);
    const file = index.get(sessionId);
    if (!file) return null;

    try {
      const [content, st] = await Promise.all([
        this.fs.readFile(file, "utf-8"),
        this.fs.stat(file),
      ]);
      return { content, mtimeMs: st.mtimeMs };
    } catch {
      // File vanished between indexing and read — treat as absent.
      return null;
    }
  }

  private indexFor(sourceInstance: string, layout: SessionLayout): Promise<Map<string, string>> {
    let idx = this.indexes.get(sourceInstance);
    if (!idx) {
      idx = this.buildIndex(layout);
      this.indexes.set(sourceInstance, idx);
    }
    return idx;
  }

  private async buildIndex(layout: SessionLayout): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let files: string[];
    try {
      files = await this.fs.glob(layout.glob, {
        cwd: layout.baseDir,
        absolute: true,
        onlyFiles: true,
      });
    } catch {
      return map;
    }
    for (const file of files) {
      const sessionId = layout.sessionIdFromPath(file);
      // Same sessionId across multiple files: keep the first (glob order); the
      // distiller's stale guard rejects any mismatch against the ledger hash.
      if (!map.has(sessionId)) map.set(sessionId, file);
    }
    return map;
  }
}
