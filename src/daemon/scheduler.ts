import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SchedulerConfig } from "../core/config.js";
import type { PipelineResult } from "../core/pipeline.js";
import { classifyResult, SourceSchedule, type SourceState } from "./source-schedule.js";

interface SchedulerPersistence {
  daemon_started_at: number;
  last_heartbeat_at: number;
  sources: Record<string, SourceState>;
}

export type RunSourceFn = (sourceId: string) => Promise<PipelineResult>;

/** Default hard cap on a single source run (10 minutes). */
export const DEFAULT_SOURCE_TIMEOUT_MS = 600_000;

export class Scheduler {
  private schedules: Map<string, SourceSchedule> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private daemon_started_at: number;
  private last_heartbeat_at: number;
  private tick_interval_ms: number;
  private source_timeout_ms: number;
  private readonly state_path: string;
  private onTick?: (sourceId: string, result: PipelineResult, duration_ms: number) => void;
  private runSource?: RunSourceFn;
  private pending: SchedulerConfig | null = null;
  private tickPromise: Promise<void> | null = null;
  private draining = false;
  private aborter: AbortController | null = null;

  constructor(config: SchedulerConfig, stateDir: string) {
    this.tick_interval_ms = config.tick_interval_secs * 1000;
    this.source_timeout_ms = config.source_timeout_ms ?? DEFAULT_SOURCE_TIMEOUT_MS;
    this.state_path = join(stateDir, "scheduler-state.json");
    this.daemon_started_at = Date.now();
    this.last_heartbeat_at = Date.now();

    const saved = this.loadState();

    for (const [sourceId, sourceConfig] of Object.entries(config.sources)) {
      if (sourceConfig.enabled === false) continue;
      const interval = sourceConfig.interval_secs ?? config.defaults.interval_secs;
      if (saved?.sources[sourceId]) {
        this.schedules.set(
          sourceId,
          SourceSchedule.fromSerialized(sourceId, interval, saved.sources[sourceId]),
        );
      } else {
        this.schedules.set(sourceId, new SourceSchedule(sourceId, interval));
      }
    }

    if (saved) {
      this.daemon_started_at = saved.daemon_started_at;
    }
  }

  getSourceIds(): string[] {
    return Array.from(this.schedules.keys());
  }

  getSourceState(sourceId: string): (SourceState & { interval_secs: number }) | undefined {
    const s = this.schedules.get(sourceId);
    if (!s) return undefined;
    return { ...s.state, interval_secs: s.interval_secs };
  }

  setRunSource(fn: RunSourceFn): void {
    this.runSource = fn;
  }

  setOnTick(fn: (sourceId: string, result: PipelineResult, duration_ms: number) => void): void {
    this.onTick = fn;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tick_interval_ms);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persistState();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    if (this.draining) return;
    this.running = true;
    this.aborter = new AbortController();
    const signal = this.aborter.signal;
    const run = (async () => {
      this.last_heartbeat_at = Date.now();
      try {
        // Snapshot eligible sources before applying pending so that sources
        // newly added by applyConfig are not run in the same tick they appear.
        const eligible = [...this.schedules.keys()];
        if (this.pending) {
          this.applyConfig(this.pending);
          this.pending = null;
        }
        const now = Date.now();
        for (const sourceId of eligible) {
          if (signal.aborted) break;
          const schedule = this.schedules.get(sourceId);
          if (!schedule) continue; // removed by applyConfig
          if (!schedule.isDue(now)) continue;
          if (!this.runSource) continue;
          this.last_heartbeat_at = Date.now();
          const start = Date.now();
          try {
            const result = await this.runSourceWithTimeout(this.runSource, sourceId);
            const duration_ms = Date.now() - start;
            schedule.recordResult(classifyResult(result), Date.now(), result.error);
            this.onTick?.(sourceId, result, duration_ms);
          } catch (err) {
            const duration_ms = Date.now() - start;
            schedule.recordResult(
              "failed",
              Date.now(),
              err instanceof Error ? err.message : String(err),
            );
            this.onTick?.(sourceId, this.fatalResult(err), duration_ms);
          }
        }
      } finally {
        this.running = false;
        this.last_heartbeat_at = Date.now();
        this.persistState();
      }
    })();
    this.tickPromise = run;
    await run;
    this.tickPromise = null;
  }

  /**
   * Races a source run against the configured hard timeout so one wedged
   * source cannot stall the tick loop forever. On timeout the returned promise
   * rejects; the caller's catch records the source as failed and the loop
   * moves on to the next source.
   */
  private runSourceWithTimeout(runSource: RunSourceFn, sourceId: string): Promise<PipelineResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Source "${sourceId}" timed out after ${this.source_timeout_ms}ms`));
      }, this.source_timeout_ms);
    });
    return Promise.race([runSource(sourceId), timeout]).finally(() => clearTimeout(timer));
  }

  private fatalResult(err: unknown): PipelineResult {
    return {
      fatal: true,
      error: err instanceof Error ? err.message : String(err),
      totalMessages: 0,
      totalBlocks: 0,
      okBlocks: 0,
      skippedBlocks: 0,
      failedBlocks: 0,
      okMessages: [],
      skippedMessages: [],
      failedMessages: [],
      warnings: [],
    };
  }

  async drain(): Promise<void> {
    this.draining = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.aborter?.abort();
    if (this.tickPromise) await this.tickPromise;
    this.persistState();
  }

  getHeartbeat(): { daemon_started_at: number; last_heartbeat_at: number } {
    return { daemon_started_at: this.daemon_started_at, last_heartbeat_at: this.last_heartbeat_at };
  }

  getAlertSources(): string[] {
    return Array.from(this.schedules.entries())
      .filter(([_, s]) => s.shouldAlert())
      .map(([id]) => id);
  }

  getAlertDetails(): Array<{ source_id: string; state: SourceState }> {
    return Array.from(this.schedules.entries())
      .filter(([_, s]) => s.shouldAlert())
      .map(([id, s]) => ({ source_id: id, state: s.serialize() }));
  }

  reconcile(config: SchedulerConfig): void {
    if (this.running) {
      // most-recent wins; earlier pending superseded
      this.pending = config;
      return;
    }
    this.applyConfig(config);
  }

  private applyConfig(config: SchedulerConfig): void {
    const nextIds = new Set(
      Object.entries(config.sources)
        .filter(([, c]) => c.enabled !== false)
        .map(([id]) => id),
    );
    for (const id of [...this.schedules.keys()]) {
      if (!nextIds.has(id)) this.schedules.delete(id);
    }
    for (const [id, sourceConfig] of Object.entries(config.sources)) {
      if (sourceConfig.enabled === false) continue;
      const interval = sourceConfig.interval_secs ?? config.defaults.interval_secs;
      const existing = this.schedules.get(id);
      if (!existing) {
        this.schedules.set(id, new SourceSchedule(id, interval));
      } else if (existing.interval_secs !== interval) {
        this.schedules.set(id, SourceSchedule.fromSerialized(id, interval, existing.serialize()));
      }
    }
    const newTick = config.tick_interval_secs * 1000;
    if (newTick !== this.tick_interval_ms) {
      this.tick_interval_ms = newTick;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => this.tick(), this.tick_interval_ms);
      }
    }
    this.persistState();
  }

  private persistState(): void {
    const data: SchedulerPersistence = {
      daemon_started_at: this.daemon_started_at,
      last_heartbeat_at: this.last_heartbeat_at,
      sources: {},
    };
    for (const [id, s] of this.schedules) {
      data.sources[id] = s.serialize();
    }
    writeFileSync(this.state_path, `${JSON.stringify(data, null, 2)}\n`);
  }

  private loadState(): SchedulerPersistence | null {
    if (!existsSync(this.state_path)) return null;
    try {
      return JSON.parse(readFileSync(this.state_path, "utf-8"));
    } catch {
      return null;
    }
  }
}
