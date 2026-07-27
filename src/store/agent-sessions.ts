// src/store/agent-sessions.ts
//
// AgentSessionStore — the processing ledger for agent transcript sources
// (claude-code / codex / hermes). One row per session REVISION, keyed by
// (source_instance, session_id, content_hash). See migration M007.
//
// This ledger replaces the lossy per-agent cursor watermark: revisions are
// detected by content_hash change (not lexicographic sessionId comparison),
// and each session's processing state is tracked independently of the scan
// watermark so a poison session never blocks progress.

import type { SqlConn } from "./sql-executor.js";

export type SessionState =
  | "discovered"
  | "distilled"
  | "applying"
  | "done"
  | "retrying"
  | "dead_letter";

export interface RecordRevisionInput {
  sourceInstance: string;
  sessionId: string;
  contentHash: string;
  byteSize: number;
  lineCount: number;
}

export interface SessionRevision {
  id: number;
  sourceInstance: string;
  sessionId: string;
  contentHash: string;
  byteSize: number;
  lineCount: number;
  state: SessionState;
  retryCount: number;
  payloadId: number | null;
  stagingAppliedAt: string | null;
  prodAppliedAt: string | null;
  discoveredAt: string;
  updatedAt: string;
}

export type RecordRevisionResult =
  | { status: "new"; revision: SessionRevision }
  | { status: "revised"; revision: SessionRevision }
  | { status: "unchanged"; revision: SessionRevision };

interface AgentSessionRow {
  id: number;
  source_instance: string;
  session_id: string;
  content_hash: string;
  byte_size: string | number;
  line_count: number;
  state: SessionState;
  retry_count: number;
  payload_id: number | null;
  staging_applied_at: string | null;
  prod_applied_at: string | null;
  discovered_at: string;
  updated_at: string;
}

// Allowed state transitions. Enforced by markState; an unlisted edge throws.
// discovered → retrying: distillation failed validation twice for this revision
// (spec §4.2 / PR-2); a later successful retry lands back as distilled.
const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  discovered: ["distilled", "retrying"],
  distilled: ["applying", "retrying"],
  applying: ["done", "retrying"],
  retrying: ["distilled", "dead_letter"],
  done: [],
  dead_letter: [],
};

function rowToRevision(row: AgentSessionRow): SessionRevision {
  return {
    id: row.id,
    sourceInstance: row.source_instance,
    sessionId: row.session_id,
    contentHash: row.content_hash,
    byteSize: typeof row.byte_size === "string" ? Number(row.byte_size) : row.byte_size,
    lineCount: row.line_count,
    state: row.state,
    retryCount: row.retry_count,
    payloadId: row.payload_id,
    stagingAppliedAt: row.staging_applied_at,
    prodAppliedAt: row.prod_applied_at,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}

export class AgentSessionStore {
  constructor(private readonly pg: SqlConn) {}

  /**
   * Idempotently record a session revision.
   * - No row for (source, session, hash) yet, and no prior hash for this session → "new"
   * - No row for this exact hash but the session already has other revisions → "revised"
   * - Exact (source, session, hash) already present → "unchanged"
   */
  async recordRevision(input: RecordRevisionInput): Promise<RecordRevisionResult> {
    const inserted = await this.pg.query<AgentSessionRow>(
      `INSERT INTO agent_sessions
         (source_instance, session_id, content_hash, byte_size, line_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_instance, session_id, content_hash) DO NOTHING
       RETURNING *`,
      [input.sourceInstance, input.sessionId, input.contentHash, input.byteSize, input.lineCount],
    );

    if (inserted.rows.length === 0) {
      // Exact revision already exists.
      const existing = await this.pg.query<AgentSessionRow>(
        `SELECT * FROM agent_sessions
         WHERE source_instance = $1 AND session_id = $2 AND content_hash = $3`,
        [input.sourceInstance, input.sessionId, input.contentHash],
      );
      return { status: "unchanged", revision: rowToRevision(existing.rows[0]) };
    }

    const revision = rowToRevision(inserted.rows[0]);

    // Did this session have prior revisions (different hashes)?
    const priorCount = await this.pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agent_sessions
       WHERE source_instance = $1 AND session_id = $2 AND content_hash <> $3`,
      [input.sourceInstance, input.sessionId, input.contentHash],
    );
    const status = priorCount.rows[0].n > 0 ? "revised" : "new";
    return { status, revision };
  }

  async getLatestRevision(
    sourceInstance: string,
    sessionId: string,
  ): Promise<SessionRevision | null> {
    const r = await this.pg.query<AgentSessionRow>(
      `SELECT * FROM agent_sessions
       WHERE source_instance = $1 AND session_id = $2
       ORDER BY discovered_at DESC, id DESC
       LIMIT 1`,
      [sourceInstance, sessionId],
    );
    return r.rows[0] ? rowToRevision(r.rows[0]) : null;
  }

  async getRevision(id: number): Promise<SessionRevision | null> {
    const r = await this.pg.query<AgentSessionRow>("SELECT * FROM agent_sessions WHERE id = $1", [
      id,
    ]);
    return r.rows[0] ? rowToRevision(r.rows[0]) : null;
  }

  async listSessions(opts?: {
    sourceInstance?: string;
    state?: SessionState;
  }): Promise<SessionRevision[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.sourceInstance) {
      params.push(opts.sourceInstance);
      clauses.push(`source_instance = $${params.length}`);
    }
    if (opts?.state) {
      params.push(opts.state);
      clauses.push(`state = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await this.pg.query<AgentSessionRow>(
      `SELECT * FROM agent_sessions ${where} ORDER BY discovered_at DESC, id DESC`,
      params,
    );
    return r.rows.map(rowToRevision);
  }

  /**
   * Transition a revision to a new state, enforcing the state machine.
   * Throws on an illegal transition. Refreshes updated_at.
   */
  async markState(id: number, nextState: SessionState): Promise<SessionRevision> {
    const current = await this.getRevision(id);
    if (!current) throw new Error(`agent_sessions row ${id} not found`);
    const allowed = ALLOWED_TRANSITIONS[current.state];
    if (!allowed.includes(nextState)) {
      throw new Error(`illegal state transition: ${current.state} → ${nextState} (row ${id})`);
    }
    const r = await this.pg.query<AgentSessionRow>(
      `UPDATE agent_sessions SET state = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, nextState],
    );
    return rowToRevision(r.rows[0]);
  }

  /**
   * Stamp the per-target apply timestamp (spec §3.1: distill state and per-target
   * apply state are recorded separately). Does NOT change `state` — a staging
   * apply must not mark the revision production-`done`. Idempotent: re-stamping is
   * harmless and doubles as the backfill's resume marker (skip already-applied).
   */
  async markTargetApplied(id: number, target: "staging" | "production"): Promise<void> {
    const col = target === "staging" ? "staging_applied_at" : "prod_applied_at";
    const r = await this.pg.query<{ id: number }>(
      `UPDATE agent_sessions SET ${col} = NOW(), updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id],
    );
    if (r.rows.length === 0) throw new Error(`agent_sessions row ${id} not found`);
  }

  /** Increment retry_count (and refresh updated_at). Threshold policy lives in the caller. */
  async incrementRetry(id: number): Promise<number> {
    const r = await this.pg.query<{ retry_count: number }>(
      `UPDATE agent_sessions SET retry_count = retry_count + 1, updated_at = NOW()
       WHERE id = $1 RETURNING retry_count`,
      [id],
    );
    if (r.rows.length === 0) throw new Error(`agent_sessions row ${id} not found`);
    return r.rows[0].retry_count;
  }
}
