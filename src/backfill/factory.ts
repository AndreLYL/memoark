// src/backfill/factory.ts
//
// Wires the BackfillDriver from real config + stores: the scan step over the
// enabled agent sources (claude-code / codex), the SessionDistiller, and the
// ShadowRunner-backed staging apply with the LLM candidate decider. This is the
// integration seam the CLI uses; the orchestration itself (driver.ts) stays
// pure and mock-tested.

import { ShadowRunner } from "../apply/shadow-runner.js";
import { claudeCodeLayout, codexLayout, type SessionLayout } from "../collectors/agent/index.js";
import { scanAgentSessions } from "../core/agent-session-scanner.js";
import type { LoadedConfig } from "../core/config.js";
import { SessionDistiller } from "../distiller/index.js";
import { createLLMProvider } from "../extractors/providers/index.js";
import type { LLMProvider } from "../extractors/providers/types.js";
import { AgentSessionStore } from "../store/agent-sessions.js";
import type { Database } from "../store/database.js";
import { DistilledPayloadStore } from "../store/distilled-payload.js";
import { LLMCandidateDecider } from "./candidate-decider.js";
import {
  BackfillDriver,
  type DistillStep,
  type ScanStep,
  type ScanSummary,
  type StageApplyStep,
} from "./driver.js";
import { backfillTranscriptParser } from "./transcript-parse.js";
import { LayoutTranscriptSource } from "./transcript-source.js";

/** Resolve which agent sources to backfill + their on-disk layouts. */
function resolveLayouts(config: LoadedConfig): Record<string, SessionLayout> {
  const layouts: Record<string, SessionLayout> = {};
  const sources = config.sources ?? {};
  if (sources["claude-code"]?.enabled !== false) {
    layouts["claude-code"] = claudeCodeLayout(sources["claude-code"]?.base_dir);
  }
  if (sources.codex?.enabled !== false) {
    layouts.codex = codexLayout(sources.codex?.base_dir);
  }
  return layouts;
}

/** Build an LLM provider from config, falling back to env for the api key. */
export function buildProvider(config: LoadedConfig): LLMProvider {
  const llm = { ...config.llm };
  if (!llm.api_key) {
    llm.api_key =
      process.env.MINIMAX_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  }
  return createLLMProvider(llm);
}

export interface BuildBackfillDriverDeps {
  config: LoadedConfig;
  db: Database;
  /** Override the provider (tests). */
  provider?: LLMProvider;
}

export function buildBackfillDriver(deps: BuildBackfillDriverDeps): BackfillDriver {
  const { config, db } = deps;
  const executor = db.executor;
  const sessions = new AgentSessionStore(executor);
  const payloads = new DistilledPayloadStore(executor);
  const provider = deps.provider ?? buildProvider(config);
  const layouts = resolveLayouts(config);

  // Scan step — run every enabled source through the ledger scanner, aggregating.
  const scanStep: ScanStep = {
    async scan(sinceMs?: number): Promise<ScanSummary> {
      const perSource: ScanSummary["perSource"] = {};
      let scanned = 0;
      let discovered = 0;
      let revised = 0;
      let skipped = 0;
      for (const [sourceInstance, layout] of Object.entries(layouts)) {
        const res = await scanAgentSessions({
          sourceInstance,
          layout,
          store: sessions,
          executor,
          sinceMs,
        });
        perSource[sourceInstance] = res;
        scanned += res.scanned;
        discovered += res.discovered;
        revised += res.revised;
        skipped += res.skipped;
      }
      return { perSource, scanned, discovered, revised, skipped };
    },
  };

  // Distill step — SessionDistiller reading transcripts straight off disk.
  const distiller = new SessionDistiller({
    sessions,
    payloads,
    provider,
    privacy: config.privacy,
    transcripts: new LayoutTranscriptSource(layouts),
    parse: backfillTranscriptParser(),
  });
  const distillStep: DistillStep = {
    runTick: (opts) => distiller.runTick(opts),
  };

  // Stage-apply step — ShadowRunner (target=staging) + real LLM candidate decider.
  const runner = new ShadowRunner({
    executor,
    decider: new LLMCandidateDecider(provider),
  });
  const stageApplier: StageApplyStep = {
    run: (payloadId) => runner.run(payloadId),
  };

  return new BackfillDriver({
    scanStep,
    distiller: distillStep,
    stageApplier,
    ledger: sessions,
    payloads,
  });
}
