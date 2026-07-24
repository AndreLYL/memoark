import type { Config, SchedulerConfig, SchedulerSourceConfig } from "../core/config.js";

/**
 * Derive the set of schedulable source ids from the enabled data channels in
 * `config.sources`.
 *
 * Every config writer (web setup wizard, AutoFetchSection, CLI init) persists
 * `scheduler.sources` as overrides only — a fresh install saves `{}` — so the
 * scheduler must NOT treat that map as the authoritative list of what to run.
 * Before this derivation existed, a default install scheduled zero sources and
 * `serve` never auto-captured anything.
 *
 * The conditions mirror what the serve runtime can actually run:
 * - agent sources: registered by bootstrapCollectors when `enabled !== false`
 * - feishu: registered when `enabled !== false` and an app_id is present
 * - feishu.docs: wired (runDocSource) only when feishu AND docs are enabled
 */
export function deriveSchedulableSources(config: Config): Record<string, SchedulerSourceConfig> {
  const derived: Record<string, SchedulerSourceConfig> = {};

  for (const id of ["claude-code", "codex", "hermes"] as const) {
    if (config.sources[id]?.enabled !== false) derived[id] = {};
  }

  const feishu = config.sources.feishu;
  if (feishu?.enabled !== false && feishu?.app_id) derived.feishu = {};
  if (feishu?.enabled && feishu.sources?.docs?.enabled) derived["feishu.docs"] = {};

  return derived;
}

/**
 * The scheduler config as the Scheduler should consume it: derived schedulable
 * sources overlaid with the user's explicit `scheduler.sources` entries, so an
 * explicit entry still wins (per-source `interval_secs`, `enabled: false`, or
 * a hand-written source id the derivation doesn't know about).
 */
export function effectiveSchedulerConfig(config: Config): SchedulerConfig | undefined {
  if (!config.scheduler) return undefined;
  return {
    ...config.scheduler,
    sources: { ...deriveSchedulableSources(config), ...config.scheduler.sources },
  };
}
