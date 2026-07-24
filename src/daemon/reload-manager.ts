import type { Config, LoadedConfig } from "../core/config.js";
import { effectiveSchedulerConfig } from "./effective-scheduler.js";
import type { ServeRuntime, ServeRuntimeHolder } from "./serve-runtime.js";

/**
 * Stable signature over the Tier-2-relevant config subset.
 * Same signature → scheduling-only change → Tier 1 reconcile.
 * Different signature → credential/pipeline change → Tier 2 rebuild.
 * Deliberately EXCLUDES the scheduler section (Tier 1's domain).
 */
export function runtimeSignature(config: Config): string {
  const subset = {
    llm: config.llm,
    embedding: config.embedding,
    privacy: config.privacy,
    block_builder: config.block_builder,
    pipeline: config.pipeline ?? null,
    sources: config.sources,
  };
  return JSON.stringify(subset);
}

/**
 * Stable signature over the store-relevant config subset.
 * A change here cannot be hot-applied — the store is instantiated once at
 * serve start and cannot be swapped at runtime. The process must restart.
 */
export function storeSignature(config: Config): string {
  const subset = {
    engine: config.store?.engine ?? "pglite",
    data_dir: config.store?.data_dir ?? null,
    database_url: config.store?.database_url ?? null,
    managed: config.store?.managed ?? null,
  };
  return JSON.stringify(subset);
}

export interface ReloadDeps {
  holder: ServeRuntimeHolder;
  /** Returns the config currently in effect (pre-reload), for signature comparison. */
  currentConfig: () => LoadedConfig;
  /** Build a brand-new runtime from a new config (= buildServeRuntime bound to stores/stateDir). */
  buildRuntime: (config: LoadedConfig) => Promise<ServeRuntime>;
  /**
   * Called when a store-section change is detected on reload.
   * The store cannot be hot-swapped — the running process continues using the
   * old database until restarted. Fired exactly once per distinct store change.
   */
  onRestartRequired?: (info: { changed: "store" }) => void;
}

export class ReloadManager {
  private running = false;
  private queued: LoadedConfig | null = null;
  private lastConfig: LoadedConfig;

  constructor(private deps: ReloadDeps) {
    this.lastConfig = deps.currentConfig();
  }

  /** single-flight: if a run is in progress, the latest config is queued and applied after. */
  async run(config: LoadedConfig): Promise<void> {
    if (this.running) {
      this.queued = config;
      return;
    }
    this.running = true;
    try {
      await this.apply(config);
      while (this.queued) {
        const next = this.queued;
        this.queued = null;
        await this.apply(next);
      }
    } finally {
      this.running = false;
    }
  }

  private async apply(config: LoadedConfig): Promise<void> {
    // Detect store changes first. The store cannot be hot-swapped, so we flag
    // restart-required and skip any attempt to apply the store change. Non-store
    // parts of the config (Tier-1/Tier-2) still proceed normally below.
    const prevStoreSig = storeSignature(this.lastConfig);
    const nextStoreSig = storeSignature(config);
    if (prevStoreSig !== nextStoreSig) {
      this.deps.onRestartRequired?.({ changed: "store" });
    }

    const prevSig = runtimeSignature(this.lastConfig);
    const nextSig = runtimeSignature(config);
    // A scheduler.enabled flip must rebuild (Tier 2): a runtime built with the
    // scheduler disabled has no runSource wired, and reconcile() never starts or
    // stops the tick loop — so a Tier-1 reconcile would leave the Auto-fetch
    // toggle without effect until the process restarts.
    const schedulerFlipped =
      (this.lastConfig.scheduler?.enabled ?? false) !== (config.scheduler?.enabled ?? false);
    if (prevSig === nextSig && !schedulerFlipped) {
      // Tier 1: scheduling-only change. Reconcile with the EFFECTIVE config —
      // the raw block's `sources` map holds only overrides (empty on a fresh
      // install), and reconciling with it would delete every derived schedule.
      const scheduler = effectiveSchedulerConfig(config);
      if (scheduler) this.deps.holder.current.scheduler?.reconcile(scheduler);
    } else {
      // Tier 2: build FIRST (failure leaves old untouched), then drain old → swap → start new → dispose old.
      const next = await this.deps.buildRuntime(config); // throws → old runtime untouched, error bubbles
      const old = this.deps.holder.current;
      await old.scheduler?.drain();
      this.deps.holder.swap(next);
      if (config.scheduler?.enabled) await next.scheduler?.start();
      await old.dispose();
    }
    this.lastConfig = config;
  }
}
