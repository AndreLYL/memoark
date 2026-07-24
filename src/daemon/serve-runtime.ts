import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { ChatNameResolver } from "../collectors/feishu/chat-name-resolver.js";
import { normalizeDocsConfig } from "../collectors/feishu/docs/config.js";
import { runDocSource } from "../collectors/feishu/docs/run.js";
import { LarkCliHttpClient } from "../collectors/feishu/lark-cli-client.js";
import { LarkCliIdentityBackend } from "../collectors/feishu/lark-cli-identity-backend.js";
import { resolveSelfOpenId } from "../collectors/feishu/self-open-id.js";
import {
  createClaudeCodeCollector,
  createCodexCollector,
  createFeishuCollector,
  createHermesCollector,
  getCollector,
  registerCollector,
  resetRegistry,
} from "../collectors/index.js";
import { type LoadedConfig, resolveAgentPipelineMode, type SourcesConfig } from "../core/config.js";
import { CursorStore } from "../core/cursors.js";
import { PersonIdentityStore } from "../core/person-identity.js";
import {
  isLegacyExtractionRetired,
  type PipelineConfig,
  type PipelineResult,
  runPipeline,
} from "../core/pipeline.js";
import { buildPipelineConfig } from "../core/pipeline-factory.js";
import { createLLMProvider, createMockProvider } from "../extractors/providers/index.js";
import type { AccumulateDeps } from "../profile/accumulate.js";
import type { DaemonStatus, StoreContext } from "../server/api.js";
import { ChatNameRefreshJob } from "../server/chat-name-refresh-job.js";
import { PersonBehaviorStore } from "../store/person-behavior.js";
import { effectiveSchedulerConfig } from "./effective-scheduler.js";
import { Scheduler } from "./scheduler.js";

/** A serve session's config-derived runtime, rebuilt/replaced as a whole on reload. */
export interface ServeRuntime {
  scheduler: Scheduler | undefined;
  chatNameRefreshJob: ChatNameRefreshJob | undefined;
  getDaemonStatus: () => DaemonStatus | undefined;
  /** Stop timers, release docsClient/docsCursor/chatNameRefreshJob and other resources. */
  dispose: () => Promise<void>;
}

/** Mutable holder: route handlers read `.current` (indirection) — never capture the runtime by value. */
export class ServeRuntimeHolder {
  current: ServeRuntime;
  constructor(initial: ServeRuntime) {
    this.current = initial;
  }
  swap(next: ServeRuntime): void {
    this.current = next;
  }
}

// ── Helpers (replicated from cli.ts; factored here for rebuildability) ───────

/** A benign no-op pipeline result for a source the scheduler intentionally skips. */
function emptyPipelineResult(): PipelineResult {
  return {
    fatal: false,
    error: undefined,
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

function resolveProjectPath(path: string | undefined, projectRoot: string): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path === "~") return homedir();
  if (isAbsolute(path)) return path;
  return resolve(projectRoot, path);
}

function bootstrapCollectors(sources: SourcesConfig, projectRoot: string): void {
  resetRegistry();
  const agentConfigs = {
    "claude-code": { factory: createClaudeCodeCollector, config: sources["claude-code"] },
    codex: { factory: createCodexCollector, config: sources.codex },
    hermes: { factory: createHermesCollector, config: sources.hermes },
  };

  for (const { factory, config } of Object.values(agentConfigs)) {
    if (config?.enabled !== false) {
      registerCollector(factory(resolveProjectPath(config?.base_dir, projectRoot)));
    }
  }

  if (sources.feishu?.enabled !== false && sources.feishu?.app_id) {
    registerCollector(createFeishuCollector(sources.feishu));
  }
}

// ── buildServeRuntime ─────────────────────────────────────────────────────────

/**
 * Build the config-derived serve runtime (scheduler, chatNameRefreshJob,
 * getDaemonStatus, dispose). Extracted from the `serve` command action so
 * it can be rebuilt on config change (Task 8).
 *
 * NOTE: The scheduler is constructed even when `config.scheduler.enabled` is
 * false, so the holder always has a Scheduler instance available for cold-start
 * logic. `scheduler.start()` is NOT called here — the caller decides.
 *
 * Assembly is covered by the serve integration test wired in Task 8.
 */
export async function buildServeRuntime(
  config: LoadedConfig,
  stores: StoreContext,
  stateDir: string,
): Promise<ServeRuntime> {
  let scheduler: Scheduler | undefined;

  // Track resources that need cleanup so dispose() can release them.
  let docsClient: LarkCliHttpClient | undefined;
  let docsCursor: CursorStore | undefined;
  let chatNameRefreshJob: ChatNameRefreshJob | undefined;

  // Effective scheduler config: schedulable sources are derived from the enabled
  // data channels; `scheduler.sources` only carries per-source overrides. Fresh
  // installs save `sources: {}` — constructing the Scheduler from the raw block
  // scheduled nothing, so serve never auto-captured any channel.
  const schedulerConfig = effectiveSchedulerConfig(config);
  if (schedulerConfig) {
    // Always construct Scheduler when the block is present (even if enabled=false),
    // so ServeRuntimeHolder always holds a Scheduler for future cold-start wiring.
    scheduler = new Scheduler(schedulerConfig, stateDir);

    if (schedulerConfig.enabled) {
      bootstrapCollectors(config.sources, config.__context.projectRoot);

      const llmConfig = { ...config.llm };
      const envKey =
        llmConfig.provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;
      if (!llmConfig.api_key && envKey) llmConfig.api_key = envKey;
      const provider = llmConfig.api_key
        ? createLLMProvider(llmConfig)
        : createMockProvider(new Map());

      // Shared factory so dedup/cursor/redaction-map state anchors to the config
      // root exactly like `memkin extract`. The hand-rolled config this replaces
      // defaulted statePath to process.cwd(), so a daemon launched with cwd=/ or
      // cwd=$HOME scattered its checkpoints away from scheduler-state.json.
      const pipelineConfig: PipelineConfig = buildPipelineConfig(config, process.cwd());

      // ── Person communication profile (Spec 8): behavior-layer accumulation.
      // No-op unless config.profile.enabled (checked inside accumulateBehavior),
      // so it is wired unconditionally. resolveSender maps a sender open id to its
      // canonical person slug via the identity handle table, falling back to a
      // deterministic slug when unknown.
      const behaviorIdentity = new PersonIdentityStore(stores.db.executor, { pages: stores.pages });
      const behaviorDeps: AccumulateDeps = {
        store: new PersonBehaviorStore(stores.db.executor),
        config: config.profile,
        resolveSender: async (contact) =>
          (await behaviorIdentity.resolveHandle("feishu_open_id", contact)) ?? `people/${contact}`,
      };

      // ── G2: feishu.docs special case ────────────────────────────────────────
      // docs uses runDocSource (not runPipeline) and manages its own cursor state,
      // sharing the pipeline's cursor file so both anchor to the config root.
      docsCursor = new CursorStore(pipelineConfig.cursor_checkpoint);
      const feishuCfg = config.sources.feishu;
      docsClient =
        feishuCfg?.enabled && feishuCfg.sources?.docs?.enabled
          ? new LarkCliHttpClient(feishuCfg.lark_bin)
          : undefined;
      const docsResolved = feishuCfg?.sources?.docs?.enabled
        ? normalizeDocsConfig(feishuCfg.sources.docs)
        : undefined;

      const runDocsAsPipelineResult = async (): Promise<PipelineResult> => {
        if (!docsClient || !docsResolved || !docsCursor)
          throw new Error("feishu.docs scheduled but docs source not enabled");
        docsCursor.load();
        const selfOpenId =
          docsResolved.self_open_id ??
          (await resolveSelfOpenId(docsClient, feishuCfg?.sources?.dm?.self_open_id)) ??
          "";
        const stats = await runDocSource({
          client: docsClient,
          stores,
          provider,
          config: docsResolved,
          cursor: docsCursor,
          selfOpenId,
          nowMs: Date.now(),
          nowIso: () => new Date().toISOString(),
        });
        console.log(
          `[scheduler] feishu.docs: scanned=${stats.candidates_scanned} pointer=${stats.pointer_saved} full=${stats.full_card_generated} refreshed=${stats.full_card_refreshed} queue=${stats.upgrade_queue_size}`,
        );
        return {
          fatal: false,
          error: undefined,
          totalMessages: stats.candidates_scanned,
          totalBlocks: stats.full_card_generated + stats.pointer_saved + stats.full_card_refreshed,
          okBlocks: stats.full_card_generated + stats.pointer_saved + stats.full_card_refreshed,
          skippedBlocks: stats.skipped,
          failedBlocks: stats.llm_failed,
          okMessages: [],
          skippedMessages: [],
          failedMessages: [],
          warnings: [],
        };
      };
      // ── end feishu.docs special case ─────────────────────────────────────────

      scheduler.setRunSource(async (sourceId) => {
        if (sourceId === "feishu.docs") {
          return runDocsAsPipelineResult();
        }
        // Legacy retirement (spec §3.1, PR-6): an agent source flipped to
        // shadow / new no longer runs the legacy block-extraction pipeline — the
        // new apply engine handles it. Flag-gated, so the default (legacy) is
        // unchanged and merging PR-6 never stops legacy on its own.
        if (isLegacyExtractionRetired(config, sourceId)) {
          console.log(
            `[scheduler] ${sourceId}: legacy extraction retired (agent_pipeline=${resolveAgentPipelineMode(config, sourceId)}); handled by the new pipeline`,
          );
          return emptyPipelineResult();
        }
        const collector = getCollector(sourceId);
        if (!collector) throw new Error(`Unknown source: ${sourceId}`);
        return runPipeline(pipelineConfig, {
          source: collector,
          provider,
          format: "json",
          adapter: "store",
          stores,
          dryRun: false,
          behavior: behaviorDeps,
        });
      });
      scheduler.setOnTick((sourceId, result, duration_ms) => {
        const status = result.fatal ? "failed" : "ok";
        console.log(`[scheduler] ${sourceId}: ${status} (${duration_ms}ms)`);
      });
      // NOTE: scheduler.start() is NOT called here — the caller (cli.ts / ReloadManager) starts it.
    }
  }

  // ── G1: getDaemonStatus closure ──────────────────────────────────────────────
  const getDaemonStatus = scheduler
    ? (): DaemonStatus => {
        const hb = scheduler?.getHeartbeat();
        const now = Date.now();
        let lastRunAt: number | null = null;
        let nextAt: number | null = null;
        for (const id of scheduler?.getSourceIds() ?? []) {
          const s = scheduler?.getSourceState(id);
          if (!s) continue;
          if (s.last_run_at !== null && (lastRunAt === null || s.last_run_at > lastRunAt)) {
            lastRunAt = s.last_run_at;
          }
          const next = s.last_run_at !== null ? s.last_run_at + s.interval_secs * 1000 : now;
          if (nextAt === null || next < nextAt) nextAt = next;
        }
        return {
          running: true,
          uptime_seconds: Math.floor((now - (hb?.daemon_started_at ?? now)) / 1000),
          last_run: lastRunAt ? new Date(lastRunAt).toISOString() : null,
          next_scheduled: nextAt !== null ? new Date(nextAt).toISOString() : null,
        };
      }
    : () => undefined;

  // ── G1: chatNameRefreshJob (config/credential-derived; rebuilt on Tier 2 reload) ──
  let chatNameRefreshLarkClient: LarkCliHttpClient | undefined;
  if (config.sources.feishu?.enabled) {
    chatNameRefreshLarkClient = new LarkCliHttpClient(config.sources.feishu.lark_bin);
    const selfOpenId = await resolveSelfOpenId(
      chatNameRefreshLarkClient,
      config.sources.feishu.sources?.dm?.self_open_id,
    );
    const backend = new LarkCliIdentityBackend(chatNameRefreshLarkClient, selfOpenId ?? undefined);
    const resolver = new ChatNameResolver(stores.db.executor, backend);
    chatNameRefreshJob = new ChatNameRefreshJob(stores.db.executor, resolver);
  }

  // ── dispose ───────────────────────────────────────────────────────────────────
  const dispose = async (): Promise<void> => {
    // Stop the scheduler timer (safe to call even if never started).
    scheduler?.stop();
    // ChatNameRefreshJob is on-demand only (no setInterval/timer); no teardown needed.
    // Drop docs resource references to release the lark-cli handles.
    docsClient = undefined;
    docsCursor = undefined;
    chatNameRefreshLarkClient = undefined;
  };

  return {
    scheduler,
    chatNameRefreshJob,
    getDaemonStatus,
    dispose,
  };
}
