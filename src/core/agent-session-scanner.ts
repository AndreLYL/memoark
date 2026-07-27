// src/core/agent-session-scanner.ts
//
// AgentSessionScanner — PR-0 foundation of the session-level distillation pipeline.
//
// Scans an agent transcript source's files, records each STABLE revision into the
// agent_sessions ledger (M007), and advances a per-source scan watermark. The watermark
// (max file mtime seen) is decoupled from per-session processing state: it always advances,
// so a poison / dead_lettered session never blocks the scan from moving forward. This
// replaces the lossy per-agent cursor (claude-code's lexicographic `sessionId <= cursor`).
//
// This module does NOT distill or apply — that is PR-2 / PR-4. It only records `discovered`.

import * as fsp from "node:fs/promises";
import fg from "fast-glob";
import { readStableSnapshot } from "../collectors/agent/collector.js";
import type { SessionLayout } from "../collectors/agent/types.js";
import type { AgentSessionStore } from "../store/agent-sessions.js";
import type { SqlConn } from "../store/sql-executor.js";
import { readMeta, writeMeta } from "../store/store-meta.js";

export interface ScanAgentSessionsOpts {
  sourceInstance: string;
  layout: SessionLayout;
  store: AgentSessionStore;
  executor: SqlConn;
  /**
   * Optional lower bound on file mtime (ms). Files older than this are not
   * recorded — the `--since` lever for historical backfill so a small, recent
   * window can be validated before scanning the full 5-6 weeks. The watermark
   * still tracks the newest file seen regardless of this filter.
   */
  sinceMs?: number;
}

export interface ScanResult {
  /** Files seen this tick. */
  scanned: number;
  /** Brand-new session revisions recorded. */
  discovered: number;
  /** Existing sessions that gained a new revision (content changed). */
  revised: number;
  /** Files skipped because they were being written under us (unstable snapshot). */
  skipped: number;
  /** New watermark value (max file mtimeMs), or the prior value if nothing advanced. */
  watermark: number;
}

function watermarkKey(sourceInstance: string): string {
  return `agent_watermark:${sourceInstance}`;
}

export async function scanAgentSessions(opts: ScanAgentSessionsOpts): Promise<ScanResult> {
  const { sourceInstance, layout, store, executor } = opts;

  const files = await discoverFiles(layout);
  const priorWatermark = Number((await readMeta(executor, watermarkKey(sourceInstance))) ?? "0");

  let discovered = 0;
  let revised = 0;
  let skipped = 0;
  let maxMtime = priorWatermark;

  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = (await fsp.stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > maxMtime) maxMtime = mtimeMs;

    // `--since` filter: skip files older than the requested window (watermark
    // already tracked above, so it still advances past skipped-older files).
    if (opts.sinceMs != null && mtimeMs < opts.sinceMs) continue;

    const snapshot = await readStableSnapshot(file);
    if (!snapshot) {
      skipped++;
      continue;
    }

    const sessionId = layout.sessionIdFromPath(file);
    const res = await store.recordRevision({
      sourceInstance,
      sessionId,
      contentHash: snapshot.contentHash,
      byteSize: snapshot.byteSize,
      lineCount: snapshot.lineCount,
    });
    if (res.status === "new") discovered++;
    else if (res.status === "revised") revised++;
  }

  // Watermark advances unconditionally — independent of any session's processing state.
  if (maxMtime > priorWatermark) {
    await writeMeta(executor, watermarkKey(sourceInstance), String(maxMtime));
  }

  return { scanned: files.length, discovered, revised, skipped, watermark: maxMtime };
}

async function discoverFiles(layout: SessionLayout): Promise<string[]> {
  try {
    return await fg(layout.glob, { cwd: layout.baseDir, absolute: true, onlyFiles: true });
  } catch {
    return [];
  }
}
