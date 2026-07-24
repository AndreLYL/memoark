import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { planStartup, shouldOpenBrowserOnServe } from "./cli-helpers.js";
import { createStores, openIdentityStore, openSessionLedger } from "./cli-stores.js";
import { normalizeDocsConfig } from "./collectors/feishu/docs/config.js";
import { FullCardBuilder } from "./collectors/feishu/docs/full-builder.js";
import type { IngestDeps } from "./collectors/feishu/docs/ingest.js";
import { runDocSource } from "./collectors/feishu/docs/run.js";
import { failedCards, summarizeCards } from "./collectors/feishu/docs/status.js";
import { loadExistingCard, writeCard } from "./collectors/feishu/docs/store-writer.js";
import { LarkCliHttpClient } from "./collectors/feishu/lark-cli-client.js";
import { resolveSelfOpenId } from "./collectors/feishu/self-open-id.js";
import {
  createClaudeCodeCollector,
  createCodexCollector,
  createFeishuCollector,
  createHermesCollector,
  getAllCollectors,
  getCollector,
  registerCollector,
  resetRegistry,
} from "./collectors/index.js";
import { type ConsolidateMode, Consolidator } from "./consolidator/consolidator.js";
import {
  type LoadedConfig,
  loadConfig,
  resolveConfigPath,
  type SourcesConfig,
} from "./core/config.js";
import { CursorStore } from "./core/cursors.js";
import { getMissingEnvVarsForCommand, validateEnvForCommand } from "./core/env-validation.js";
import { type HandleKind, PersonIdentityStore } from "./core/person-identity.js";
import { runPipeline } from "./core/pipeline.js";
import { buildPipelineConfig } from "./core/pipeline-factory.js";
import { ensureStateDir, stateDirFor, statePath } from "./core/state.js";
import {
  rawYamlHash,
  readDaemonState,
  recoverServeConfigPath,
  servingSubsetHash,
} from "./daemon/autostart/daemon-state.js";
import { disableAutostart, statusAutostart } from "./daemon/autostart/index.js";
import { nodeRunner } from "./daemon/autostart/runner.js";
import { startEmbedSweep } from "./daemon/embed-sweep.js";
import { ReloadManager } from "./daemon/reload-manager.js";
import { buildServeRuntime, ServeRuntimeHolder } from "./daemon/serve-runtime.js";
import { VERSION } from "./embedded-assets.generated.js";
import { createLLMProvider, createMockProvider } from "./extractors/providers/index.js";
import { hooksInstall, hooksUninstall } from "./hooks/install.js";
import type { HookInput } from "./hooks/output.js";
import { runHookEvent } from "./hooks/run-event.js";
import { type PlannedClient, runInstall, runUninstall } from "./install/index.js";
import { scaffoldSkill } from "./install/skill.js";
import { down } from "./lifecycle/down.js";
import { migrateLegacyData } from "./lifecycle/legacy-migration.js";
import { acquireLifecycleLock } from "./lifecycle/lifecycle-lock.js";
import { runUp } from "./lifecycle/run-up.js";
import { computeStatus, formatManagedStatus } from "./lifecycle/status.js";
import { createApiApp } from "./server/api.js";
import { getSessionContext } from "./server/context.js";
import { createMcpServer } from "./server/mcp.js";
import { createMcpHttpApp } from "./server/mcp-http.js";
import {
  assertLoopbackOrThrow,
  resolveDaemonLaunchRuntime,
  resolveMcpHttpRuntime,
} from "./server/mcp-http-runtime.js";
import { openBrowser } from "./server/open-browser.js";
import { startServer } from "./server/runtime.js";
import { serveHttp, serveStaticSpa } from "./server/serve.js";
import { resolveServeSecurity } from "./server/server-security.js";
import { DistilledPayloadStore } from "./store/distilled-payload.js";
import { EntityMergeSuggestionStore } from "./store/entity-suggestions.js";
import { managedPaths, readManagedState } from "./store/managed/pg-paths.js";
import { startRecoveryLoop } from "./store/managed/recovery-loop.js";
import { stopManagedFromState } from "./store/managed/stop-from-state.js";
import { PersonBehaviorStore } from "./store/person-behavior.js";

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

  for (const [_id, { factory, config }] of Object.entries(agentConfigs)) {
    if (config?.enabled !== false) {
      registerCollector(factory(resolveProjectPath(config?.base_dir, projectRoot)));
    }
  }

  if (sources.feishu?.enabled !== false && sources.feishu?.app_id) {
    registerCollector(createFeishuCollector(sources.feishu));
  }
}

// Try to extract feishu.lark_bin from an existing config so the setup UI's
// "Feishu — Test Connection" button doesn't fall through to the hardcoded
// ~/.local/bin/lark path. Silent on missing file or parse errors (the wizard
// may be running because the YAML doesn't exist yet).
function readLarkBinFromConfig(configPath?: string): string | undefined {
  const path = configPath ?? resolve(process.cwd(), "memkin.yaml");
  if (!existsSync(path)) return undefined;
  try {
    return loadConfig(path).sources?.feishu?.lark_bin;
  } catch {
    return undefined;
  }
}

const program = new Command();

program
  .name("memkin")
  .description("Local-first personal memory extraction and storage")
  .version(VERSION);

// One-shot legacy auto-migration (memoark → memkin). Runs BEFORE every command's
// action — i.e. before loadConfig reads memkin.yaml or any store opens — so
// existing users' data/config/state are moved to the new paths seamlessly.
// preAction fires for subcommands AND the default program action, covering
// serve / extract / init / start (and the Tauri sidecar, which shells out to
// `memkin serve`). All notices go to STDERR: in `serve --mcp` stdout is the
// JSON-RPC channel and must stay byte-clean, so migration output can never use it.
program.hook("preAction", () => {
  try {
    migrateLegacyData({ home: homedir(), cwd: process.cwd(), env: process.env });
  } catch (err) {
    // Migration is best-effort: a failure must never block the command. Report
    // to stderr and continue (the command will fall through to fresh defaults).
    console.error(
      `[migration] legacy data migration skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

program
  .command("init")
  .description("Interactive setup wizard - generates memkin.yaml")
  .option("--auto", "Automatic mode, no prompts")
  .option("--force", "Overwrite existing configuration")
  .option("-c, --config <path>", "Path to output config file (default: memkin.yaml)")
  .option("--no-tui", "Use non-TUI fallback")
  .option("--web", "Launch browser-based setup UI")
  .action(async (options) => {
    if (options.web) {
      const { startSetupServer } = await import("./server/setup-server.js");
      await startSetupServer({
        configPath: options.config,
        larkBin: readLarkBinFromConfig(options.config),
      });
      return;
    }
    try {
      const { runInit } = await import("./setup/index.js");
      await runInit({
        auto: options.auto,
        force: options.force,
        configPath: options.config,
        tui: options.tui,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

/**
 * Extract command - main pipeline execution
 */
program
  .command("extract")
  .description("Extract signals from a platform or source")
  .option(
    "-s, --source <name>",
    "Source/collector name (e.g., claude-code, codex, hermes, feishu, or 'all' for all enabled sources)",
    "claude-code",
  )
  .option("-c, --config <path>", "Path to config file (default: memkin.yaml)")
  .option("-f, --format <type>", "Output format (json|markdown)", "json")
  .option("-a, --adapter <type>", "Output adapter (store|file|gbrain|stdout)", "store")
  .option("-o, --output <dir>", "Output directory for file adapter")
  .option("--since <date>", "Only process messages since date (ISO 8601 or relative: 1d, 2h, 30m)")
  .option("--limit <n>", "Limit number of messages to process", undefined)
  .option("--dry-run", "Do not write outputs, only test pipeline")
  .action(async (options) => {
    try {
      // Load configuration
      const config = loadConfig(options.config);
      const { projectRoot } = config.__context;

      // Ensure state directory exists
      ensureStateDir(projectRoot);

      // Bootstrap collectors from config
      bootstrapCollectors(config.sources, projectRoot);

      // Determine which sources to process
      let sourceIds: string[];
      if (options.source === "all") {
        sourceIds = getAllCollectors().map((c) => c.id);
      } else {
        sourceIds = [options.source];
      }

      // Create LLM provider based on config (shared across all sources)
      let provider: ReturnType<typeof createLLMProvider> | undefined;
      if (!options.dryRun) {
        validateEnvForCommand(config, "extract");
        const llmConfig = config.llm;
        const envKey =
          llmConfig.provider === "anthropic"
            ? process.env.ANTHROPIC_API_KEY
            : process.env.OPENAI_API_KEY;
        if (!llmConfig.api_key && !envKey) {
          const envVarName =
            llmConfig.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
          console.error(
            `Error: No API key configured. Set api_key in memkin.yaml or ${envVarName} env var.`,
          );
          process.exit(1);
        }
        if (!llmConfig.api_key) {
          llmConfig.api_key = envKey;
        }
        provider = createLLMProvider(llmConfig);
      } else {
        provider = createMockProvider(new Map());
      }

      // Build pipeline configuration
      const pipelineConfig = buildPipelineConfig(
        config,
        options.output || process.cwd(),
        projectRoot,
      );

      // Parse options
      const format = ["json", "markdown"].includes(options.format) ? options.format : "json";
      const adapter = ["store", "file", "gbrain", "stdout"].includes(options.adapter)
        ? options.adapter
        : "store";
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;

      // Create stores if using store adapter
      let stores: Awaited<ReturnType<typeof createStores>> | undefined;
      if (adapter === "store") {
        stores = await createStores(config);
      }

      // Parse relative since values
      let sinceValue = options.since;
      if (sinceValue) {
        const relMatch = sinceValue.match(/^(\d+)([dhm])$/);
        if (relMatch) {
          const amount = parseInt(relMatch[1], 10);
          const unit = relMatch[2];
          const ms =
            unit === "d" ? amount * 86400000 : unit === "h" ? amount * 3600000 : amount * 60000;
          sinceValue = new Date(Date.now() - ms).toISOString();
        }
      }

      let anyFailed = false;

      // Process each source
      for (const sourceId of sourceIds) {
        const collector = getCollector(sourceId);
        if (!collector) {
          console.error(`Error: Unknown source '${sourceId}'`);
          anyFailed = true;
          continue;
        }

        // Health check
        const health = await collector.healthCheck();
        if (!health.ok) {
          if (options.source === "all") {
            console.warn(`Warning: ${sourceId} not available — ${health.message}. Skipping.`);
            continue;
          }
          console.error(`Error: ${sourceId} health check failed — ${health.message}`);
          process.exit(1);
        }

        // Run pipeline for this source
        console.log(`\n--- Extracting from: ${sourceId} ---`);
        console.log(`Format: ${format}, Adapter: ${adapter}`);
        if (options.dryRun) console.log("DRY-RUN mode enabled");
        if (sinceValue) console.log(`Since: ${sinceValue}`);
        if (limit) console.log(`Limit: ${limit} messages`);
        console.log("");

        try {
          const result = await runPipeline(pipelineConfig, {
            source: collector,
            provider,
            format: format as "json" | "markdown",
            adapter: adapter as "store" | "file" | "gbrain" | "stdout",
            stores,
            dryRun: options.dryRun || false,
            since: sinceValue,
            limit,
          });

          // Report results
          console.log("Pipeline execution complete:");
          console.log(`  Total messages: ${result.totalMessages}`);
          console.log(`  Total blocks: ${result.totalBlocks}`);
          console.log(`  OK blocks: ${result.okBlocks}`);
          console.log(`  Skipped blocks: ${result.skippedBlocks}`);
          console.log(`  Failed blocks: ${result.failedBlocks}`);

          if (result.warnings.length > 0) {
            console.log("\nWarnings:");
            for (const warning of result.warnings) {
              console.log(`  - ${warning}`);
            }
          }

          if (result.fatal) {
            console.error(`\nFatal error: ${result.error}`);
            anyFailed = true;
          }
        } catch (error) {
          console.error(
            `\nPipeline failed for ${sourceId}:`,
            error instanceof Error ? error.message : String(error),
          );
          anyFailed = true;
        }
      }

      // Close stores if they were created
      if (stores) {
        await stores.db.close();
      }

      if (anyFailed) {
        process.exit(1);
      }
    } catch (error) {
      console.error("Extract failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

/**
 * Doctor command - diagnose configuration and setup
 */
program
  .command("doctor")
  .description("Diagnose configuration and connectivity")
  .option("-c, --config <path>", "Path to config file (default: memkin.yaml)")
  .action(async (options) => {
    const issues: string[] = [];
    const warnings: string[] = [];
    const ok: string[] = [];

    // Check config file
    const configPath = resolveConfigPath(options.config);
    let config: LoadedConfig | null = null;
    if (existsSync(configPath)) {
      ok.push(`Configuration file found: ${configPath}`);
      try {
        config = loadConfig(options.config);
        ok.push("Configuration loaded successfully");
      } catch (error) {
        issues.push(
          `Configuration loading failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      warnings.push(`Configuration file not found: ${configPath}`);
      warnings.push("Create one with: memkin init");
    }

    // Check state directory (stateDirFor, NOT resolve(root, ".memkin") — the
    // home install's projectRoot already IS ~/.memkin, and recomputing the
    // nested path here would make doctor bless the very layout bug it should flag)
    const projectRoot = config?.__context.projectRoot ?? dirname(configPath);
    const stateDir = stateDirFor(projectRoot);
    if (existsSync(stateDir)) {
      ok.push(`State directory exists: ${stateDir}`);
    } else {
      warnings.push(`State directory does not exist: ${stateDir}`);
      warnings.push("It will be created automatically on first extract");
    }

    const cwdStateDir = stateDirFor();
    if (cwdStateDir !== stateDir && existsSync(cwdStateDir)) {
      warnings.push(`Legacy state directory found at current cwd: ${cwdStateDir}`);
      warnings.push(`Current config-root state directory is: ${stateDir}`);
      warnings.push("Move cursor/dedup files manually if you intended to reuse the old state.");
    }

    // Check LLM configuration
    if (config) {
      const missingEnvVars = getMissingEnvVarsForCommand(config, "doctor");
      if (missingEnvVars.length > 0) {
        warnings.push(`Missing environment variables: ${missingEnvVars.join(", ")}`);
        warnings.push(`Referenced by: ${config.__context.configPath}`);
      }

      if (config.llm?.provider && config.llm?.model) {
        ok.push(`LLM provider configured: ${config.llm.provider} / ${config.llm.model}`);

        const envKey = config.llm.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        if (!missingEnvVars.includes(envKey)) {
          ok.push(`${config.llm.provider} API key configured`);
        } else {
          warnings.push(`${envKey} environment variable not set and no api_key in config`);
          warnings.push(`Set ${envKey} or add api_key to llm config`);
        }
      } else {
        issues.push("LLM provider or model not configured");
      }

      // Check sources
      bootstrapCollectors(config.sources, config.__context.projectRoot);
      for (const collector of getAllCollectors()) {
        const health = await collector.healthCheck();
        if (health.ok) {
          ok.push(`Source ${collector.id}: ${health.message}`);
        } else {
          warnings.push(`Source ${collector.id}: ${health.message}`);
        }
      }

      // Check Postgres engine
      if ((config.store?.engine ?? "pglite") === "postgres") {
        const dbUrl = config.store?.database_url;
        if (!dbUrl) {
          issues.push("Postgres: store.database_url is not set");
        } else {
          const { checkPostgres } = await import("./setup/doctor.js");
          const { maskDatabaseUrl } = await import("./config-center/secrets.js");
          const pg = await checkPostgres(dbUrl);
          if (!pg.connected) {
            issues.push(`Postgres: cannot connect to ${maskDatabaseUrl(dbUrl)}`);
          } else {
            ok.push(`Postgres: connected ✓ (${maskDatabaseUrl(dbUrl)})`);
            if (pg.vectorReady) {
              ok.push("Postgres: pgvector ready ✓");
            } else {
              issues.push(
                "Postgres: pgvector extension is not available or cannot be created — " +
                  "install pgvector and ensure the role has permission to CREATE EXTENSION",
              );
            }
            const { checkPgIdSequences } = await import("./setup/doctor.js");
            const desync = await checkPgIdSequences(dbUrl);
            if (desync === null) {
              warnings.push("Postgres: id sequence check could not run (connection error)");
            } else if (desync.length > 0) {
              warnings.push(
                `Postgres: id sequence desync on ${desync
                  .map((d) => `${d.table} (max id ${d.maxId}, sequence would yield ${d.nextValue})`)
                  .join(", ")} — usually caused by an id-preserving import/restore. ` +
                  "Writes to new slugs fail with duplicate-key errors until repaired; " +
                  "memoark repairs this automatically the next time the store is opened " +
                  "(any command that touches the store, e.g. `memoark serve`).",
              );
            } else {
              ok.push("Postgres: id sequences in sync ✓");
            }
          }
        }
      }

      // Check managed Postgres engine
      if (config.store?.engine === "managed") {
        const { checkManagedPostgres } = await import("./setup/doctor.js");
        const checks = await checkManagedPostgres({
          home: homedir(),
          managedConfig: config.store.managed,
        });
        for (const check of checks) {
          if (check.severity === "ok") {
            ok.push(check.message);
          } else if (check.severity === "warn") {
            warnings.push(check.message);
          } else {
            issues.push(check.message);
          }
        }
      }
    }

    // Report results
    console.log("=== Memkin Diagnostic Report ===\n");

    if (ok.length > 0) {
      console.log("✓ OK:");
      for (const msg of ok) {
        console.log(`  ${msg}`);
      }
      console.log("");
    }

    if (warnings.length > 0) {
      console.log("⚠ Warnings:");
      for (const msg of warnings) {
        console.log(`  ${msg}`);
      }
      console.log("");
    }

    if (issues.length > 0) {
      console.log("✗ Issues:");
      for (const msg of issues) {
        console.log(`  ${msg}`);
      }
      console.log("");
      process.exit(1);
    }

    console.log("No critical issues found.");
  });

/**
 * Config subcommand group
 */
const configCmd = program.command("config").description("Manage configuration");

configCmd
  .command("init")
  .description("Generate memkin.yaml (alias for 'memkin init')")
  .option("--auto", "Automatic mode, no prompts")
  .option("--force", "Overwrite existing configuration")
  .option("-c, --config <path>", "Path to output config file (default: memkin.yaml)")
  .option("--no-tui", "Use non-TUI fallback")
  .action(async (options) => {
    try {
      const { runInit } = await import("./setup/index.js");
      await runInit({
        auto: options.auto,
        force: options.force,
        configPath: options.config,
        tui: options.tui,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

configCmd
  .command("edit")
  .description("Edit configuration in browser UI")
  .option("--web", "Launch browser-based settings UI (default behavior)")
  .option("-c, --config <path>", "Path to config file (default: memkin.yaml)")
  .action(async (options) => {
    const { startSetupServer } = await import("./server/setup-server.js");
    await startSetupServer({
      configPath: options.config,
      larkBin: readLarkBinFromConfig(options.config),
    });
  });

/**
 * Sources subcommand group
 */
const sourcesCmd = program.command("sources").description("Manage data sources");

sourcesCmd
  .command("list")
  .description("List available sources")
  .option("-c, --config <path>", "Path to config file")
  .action((options) => {
    const config = loadConfig(options.config);
    bootstrapCollectors(config.sources, config.__context.projectRoot);

    const collectors = getAllCollectors();
    console.log("Available sources:\n");
    for (const c of collectors) {
      console.log(`  ${c.id}  ✓ enabled`);
      console.log(`    ${c.description}`);
      console.log("");
    }
  });

sourcesCmd
  .command("test <name>")
  .description("Test source connectivity and health")
  .option("-c, --config <path>", "Path to config file")
  .action(async (name, options) => {
    try {
      const config = loadConfig(options.config);
      bootstrapCollectors(config.sources, config.__context.projectRoot);

      const collector = getCollector(name);
      if (!collector) {
        console.error(`Error: Unknown source '${name}'`);
        process.exit(1);
      }

      console.log(`Testing source: ${name}\n`);
      const health = await collector.healthCheck();
      if (health.ok) {
        console.log(`✓ ${health.message}`);
      } else {
        console.log(`✗ ${health.message}`);
        process.exit(1);
      }
    } catch (error) {
      console.error("Test failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

/**
 * Sessions subcommand group — inspect the agent_sessions processing ledger (PR-0).
 * `retry` / `purge` are interface placeholders wired for later PRs (PR-2+).
 */
const sessionsCmd = program.command("sessions").description("Inspect the agent session ledger");

sessionsCmd
  .command("ls")
  .description("List agent session revisions from the ledger")
  .option("-c, --config <path>", "Path to config file")
  .option("-s, --source <id>", "Filter by source instance (claude-code/codex/hermes)")
  .option(
    "--state <state>",
    "Filter by state (discovered/distilled/applying/done/retrying/dead_letter)",
  )
  .action(async (options) => {
    const config = loadConfig(options.config);
    const stores = await openSessionLedger(config);
    try {
      const rows = await stores.agentSessions.listSessions({
        sourceInstance: options.source,
        state: options.state,
      });
      if (rows.length === 0) {
        console.log("No agent sessions recorded yet.");
        return;
      }
      console.log(
        "id    source        session                          rev       state        retry  discovered",
      );
      for (const r of rows) {
        const sid =
          r.sessionId.length > 30 ? `${r.sessionId.slice(0, 29)}…` : r.sessionId.padEnd(30);
        console.log(
          `${String(r.id).padEnd(5)} ${r.sourceInstance.padEnd(13)} ${sid} ${r.contentHash.slice(0, 8)}  ${r.state.padEnd(11)}  ${String(r.retryCount).padEnd(5)}  ${r.discoveredAt}`,
        );
      }
    } finally {
      await stores.db.close();
    }
  });

sessionsCmd
  .command("inspect <id>")
  .description("Show a single session revision with all ledger fields")
  .option("-c, --config <path>", "Path to config file")
  .action(async (id, options) => {
    const config = loadConfig(options.config);
    const stores = await openSessionLedger(config);
    try {
      const rev = await stores.agentSessions.getRevision(Number(id));
      if (!rev) {
        console.error(`No agent session revision with id ${id}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(rev, null, 2));
    } finally {
      await stores.db.close();
    }
  });

sessionsCmd
  .command("retry <id>")
  .description("Re-queue a session revision for distillation (PR-2+)")
  .action((id) => {
    console.log(`sessions retry ${id}: not yet implemented (arrives with PR-2 distiller)`);
  });

sessionsCmd
  .command("purge <id>")
  .description("Purge a dead-lettered session revision (PR-2+)")
  .action((id) => {
    console.log(`sessions purge ${id}: not yet implemented (arrives with PR-2 distiller)`);
  });

/**
 * Backfill — historical agent-session cleanup driver (spec §11 押后 backfill).
 * Scans historical claude-code/codex JSONL into the ledger, distills discovered
 * revisions via the SessionDistiller, and applies each payload to the isolated
 * `staging` schema with the PR-4 apply engine (target=staging). Resumable +
 * idempotent; --limit/--since/--dry-run keep the first passes cheap.
 */
program
  .command("backfill")
  .description("Backfill historical agent sessions into the staging schema (validation)")
  .option("-c, --config <path>", "Path to config file")
  .option("--limit <n>", "Cap sessions processed at each stage (cost lever)")
  .option("--since <date>", "Only scan session files modified on/after this date (YYYY-MM-DD)")
  .option("--dry-run", "Scan + report projected work only; no distillation, no LLM")
  .option("--no-report", "Skip the staging-vs-public acceptance report")
  .action(async (options) => {
    const { buildBackfillDriver } = await import("./backfill/factory.js");
    const { buildBackfillReport, formatBackfillReport } = await import("./backfill/report.js");

    const config = loadConfig(options.config);

    let sinceMs: number | undefined;
    if (options.since) {
      const parsed = Date.parse(options.since);
      if (Number.isNaN(parsed)) {
        console.error(`Invalid --since date: ${options.since}`);
        process.exit(1);
      }
      sinceMs = parsed;
    }
    const limit = options.limit != null ? Number(options.limit) : undefined;
    if (limit != null && (!Number.isInteger(limit) || limit < 0)) {
      console.error(`Invalid --limit: ${options.limit}`);
      process.exit(1);
    }

    const stores = await createStores(config);
    try {
      const driver = buildBackfillDriver({ config, db: stores.db });
      const result = await driver.run({ limit, sinceMs, dryRun: Boolean(options.dryRun) });

      console.log(JSON.stringify(result, null, 2));

      if (result.stageApply && result.stageApply.productionLeak !== 0) {
        console.error(
          `\n⚠ production leak detected: ${result.stageApply.productionLeak} rows — staging isolation FAILED`,
        );
        process.exitCode = 1;
      }

      if (options.report !== false && !result.dryRun) {
        const rep = await buildBackfillReport(stores.db.executor);
        console.log(`\n${formatBackfillReport(rep)}`);
      }
    } finally {
      await stores.db.close();
    }
  });

async function runServe(options: {
  config?: string;
  mcp?: boolean;
  mcpHttp?: boolean;
  open?: boolean;
  pgliteAssets?: string;
  webDist?: string;
  port?: string;
  host?: string;
  mcpBind?: string;
  mcpPort?: number;
  mcpReadWrite?: boolean;
  mcpAllowedHost?: string[];
  daemonInstanceId?: string;
}): Promise<void> {
  {
    let serveConfigOverride = options.config;
    const serveConfigPath = options.config ?? resolve(process.cwd(), "memkin.yaml");
    if (!existsSync(serveConfigPath)) {
      // F1 self-heal: a daemon relaunch can carry a stale --config frozen into
      // the plist/unit argv (memoark → memkin rename), and daemon.json may hold
      // the same stale path. Recover via daemon.json (daemon-launched only) or
      // normal discovery, and write the fix back to daemon.json when it was
      // stale. All output on stderr — `serve --mcp` owns stdout for JSON-RPC.
      const recovered = recoverServeConfigPath({
        requestedPath: serveConfigPath,
        stateDir: join(homedir(), ".memkin"),
        trustDaemonState: Boolean(options.daemonInstanceId),
        discover: () => resolveConfigPath(),
      });
      if (!recovered) {
        console.error(
          "No configuration file found. Searched:\n" +
            `  - ${serveConfigPath}\n` +
            "  - memkin.yaml in the current directory and its parents\n" +
            `  - ${join(homedir(), ".memkin", "memkin.yaml")}\n` +
            "If your config lives elsewhere, pass it explicitly: `memkin serve -c /path/to/memkin.yaml`.\n" +
            "Otherwise run `memkin start` for one-step setup + launch, or `memkin init --web` to configure first.",
        );
        process.exit(1);
      }
      console.error(
        `[serve] Config file ${serveConfigPath} not found — using ${recovered.configPath} ` +
          `(${recovered.source === "daemon-state" ? "from daemon.json" : "discovered"}).`,
      );
      if (recovered.healedDaemonState) {
        console.error(`[serve] Updated daemon.json config_path → ${recovered.configPath}`);
      }
      serveConfigOverride = recovered.configPath;
    }
    const config = loadConfig(serveConfigOverride);
    // Anchor the .memkin state dir to the config's project root, not process.cwd().
    // A Finder-launched sidecar has cwd=/, so the default would try to mkdir /.memkin
    // (EROFS on macOS). projectRoot = dirname(configPath), so it lives beside the config.
    const stateDir = ensureStateDir(config.__context.projectRoot);
    const missingEnvVars = getMissingEnvVarsForCommand(config, "serve");
    if (missingEnvVars.length > 0) {
      console.warn(
        `[warn] Missing env vars: ${missingEnvVars.join(", ")} (referenced by ${config.__context.configPath})`,
      );
    }
    const stores = await createStores(config);

    // P1-1: recovery loop is a PROCESS-LEVEL resource — started from stores.supervisor,
    // never placed inside the ServeRuntimeHolder/runtime (which is disposed on every reload).
    const recovery = stores.supervisor
      ? startRecoveryLoop(stores.supervisor, { intervalMs: 3000 })
      : undefined;

    // Embed sweep is likewise process-level: the scheduled capture pipeline
    // writes chunks with embedding = NULL and nothing else embeds them, so
    // without this loop vector search silently degrades to FTS-only for all
    // auto-captured content. Logs go to stderr — `serve --mcp` owns stdout.
    const sweepIntervalSecs = config.embedding.sweep_interval_secs ?? 300;
    const embedSweep =
      sweepIntervalSecs > 0
        ? startEmbedSweep(stores.embedding, {
            intervalMs: sweepIntervalSecs * 1000,
            batchLimit: config.embedding.sweep_batch_limit ?? 256,
            onSweep: (r) =>
              console.error(`[embed-sweep] embedded ${r.embedded} chunks, errors ${r.errors}`),
            onError: (err, failures) =>
              console.error(
                `[embed-sweep] sweep failed (${failures} consecutive): ${err instanceof Error ? err.message : String(err)}`,
              ),
          })
        : undefined;

    const initialRuntime = await buildServeRuntime(config, stores, stateDir);
    const holder = new ServeRuntimeHolder(initialRuntime);
    if (config.scheduler?.enabled) await holder.current.scheduler?.start();

    const reloadManager = new ReloadManager({
      holder,
      // only read once at construction for the initial signature; ReloadManager tracks lastConfig internally afterward
      currentConfig: () => config,
      buildRuntime: (next) => buildServeRuntime(next, stores, stateDir),
      onRestartRequired: () =>
        console.warn(
          "[reload] store/engine change saved — restart the daemon (`memkin up` or restart serve) to apply; the running process still uses the previous database.",
        ),
    });

    const storesWithDaemon = {
      ...stores,
      getDaemonStatus: () => holder.current.getDaemonStatus(),
      // getter: always reads the current runtime, so a Tier-2 swap is seen by routes
      get chatNameRefreshJob() {
        return holder.current.chatNameRefreshJob;
      },
    };

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return; // 防重入:连按 Ctrl-C 不会二次 db.close()
      shuttingDown = true;
      // P1-1: stop recovery loop first, then dispose supervisor monitor (NOT the cluster),
      // then dispose the runtime, then close the DB connection.
      embedSweep?.stop();
      recovery?.stop();
      stores.supervisor?.dispose(); // stops monitor only — does NOT stop the cluster
      await holder.current.dispose();
      try {
        await stores.db.close(); // 触发锁 release
      } finally {
        process.exit(0); // db.close() 抛错也必须退出
      }
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    if (options.mcp) {
      const llmConfig = { ...config.llm };
      const envKey =
        llmConfig.provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;
      if (!llmConfig.api_key && envKey) llmConfig.api_key = envKey;
      const synthProvider = llmConfig.api_key
        ? createLLMProvider(llmConfig)
        : createMockProvider(new Map());

      let ingestDeps: IngestDeps | undefined;
      const feishu = config.sources.feishu;
      if (feishu?.enabled && feishu.sources?.docs?.enabled) {
        const client = new LarkCliHttpClient(feishu.lark_bin);
        ingestDeps = {
          client,
          stores: storesWithDaemon,
          provider: synthProvider,
          model: feishu.sources.docs.llm?.model ?? llmConfig.model,
          nowIso: () => new Date().toISOString(),
        };
      }
      const server = createMcpServer(
        storesWithDaemon,
        { provider: synthProvider, synthModel: llmConfig.model },
        ingestDeps,
      );
      await server.connect(new StdioServerTransport());
      return;
    }
    if (
      options.mcpHttp ||
      config.mcp.http.enabled ||
      config.server.mcp_transport === "streamable_http"
    ) {
      const runtime = resolveMcpHttpRuntime(config.mcp.http, {
        mcpBind: options.mcpBind,
        mcpPort: options.mcpPort,
        mcpReadWrite: options.mcpReadWrite,
        mcpAllowedHost: options.mcpAllowedHost,
        daemonInstanceId: options.daemonInstanceId,
      });
      assertLoopbackOrThrow(runtime);
      // Server-wide auth token (config server.auth_token / MEMKIN_AUTH_TOKEN)
      // also protects the MCP HTTP endpoint. The MCP-specific auth_token_env is
      // kept for backward compat; the server-wide token wins when both are set.
      const serverToken = resolveServeSecurity({
        configHost: config.server.host,
        configToken: config.server.auth_token,
        envToken: process.env.MEMKIN_AUTH_TOKEN,
      }).authToken;
      const tokenEnv = config.mcp.http.auth_token_env;
      const resolvedConfigPath = config.__context.configPath;
      let loadedConfigHash: string | undefined;
      try {
        loadedConfigHash = rawYamlHash(resolvedConfigPath);
      } catch {
        // config file may not exist yet; leave hash undefined
      }
      const app = createMcpHttpApp(storesWithDaemon, {
        allowedOrigins: runtime.allowedOrigins,
        allowedHosts: runtime.allowedHosts,
        authToken: serverToken ?? (tokenEnv ? process.env[tokenEnv] : undefined),
        exposeLegacyTools: config.mcp.expose_legacy_tools,
        readOnly: runtime.readOnly,
        health: {
          instanceId: runtime.instanceId,
          pid: process.pid,
          engine: config.store.engine ?? "pglite",
          version: VERSION,
          loadedConfigHash,
          // FIX 5: wire port/bind so isReady() port/bind checks are load-bearing
          port: runtime.port,
          bind: runtime.bind,
          dbProbe: async () => {
            try {
              await stores.db.executor.query("SELECT 1");
              return true;
            } catch {
              return false;
            }
          },
          pgProbe: stores.supervisor
            ? async () => (await stores.supervisor!.status()) === "running"
            : undefined,
        },
      });
      const server = await startServer(app, {
        hostname: runtime.bind,
        port: runtime.port,
      });
      console.log(
        `Memkin MCP Streamable HTTP listening on http://${server.hostname}:${server.port}/mcp`,
      );
      return;
    }

    // Resolve bind host + auth token BEFORE creating stores' HTTP surface.
    // Rule: loopback by default; a non-loopback bind REFUSES to start unless an
    // auth token is configured. When a token is set it is enforced everywhere
    // (including loopback). Throws with an actionable message on misconfig.
    const security = resolveServeSecurity({
      flagHost: options.host,
      configHost: config.server.host,
      configToken: config.server.auth_token,
      envToken: process.env.MEMKIN_AUTH_TOKEN,
    });

    const app = createApiApp(storesWithDaemon, {
      authToken: security.authToken,
      onConfigSaved: () => {
        try {
          void reloadManager.run(loadConfig(options.config)).catch((err) => {
            console.error("[reload] Runtime reload failed:", err);
          });
        } catch (err) {
          console.error("[reload] Failed to load config after save:", err);
        }
      },
    });
    // In a `bun --compile` sidecar, import.meta.url lives under $bunfs and web/dist is
    // NOT embedded, so the default path can't be served. The Tauri shell ships web/dist
    // as a resource and injects its real path via MEMKIN_WEB_DIST (mirrors pglite-assets).
    const webDist =
      process.env.MEMKIN_WEB_DIST ?? join(fileURLToPath(import.meta.url), "../../web/dist");
    // `--port 0` (used by the Tauri shell) binds an OS-assigned free port so the desktop
    // app never collides with a CLI `memkin serve`, a stale instance, or anything else
    // on the default port. The actual port is reported below for the webview to read.
    const requestedPort =
      options.port !== undefined ? Number(options.port) : config.server.http_port;
    const server = await serveHttp({
      port: requestedPort,
      // Loopback by default; `--host` / `server.host` can widen this, but only
      // when an auth token is configured (enforced by resolveServeSecurity above).
      hostname: security.host,
      fetch: async (req) => {
        const url = new URL(req.url);
        // Auth (when a token is configured) is enforced inside the Hono app's
        // /api/* middleware. Web UI static assets below stay unauthenticated —
        // they are the app shell, not data.
        if (url.pathname.startsWith("/api")) return app.fetch(req);
        return serveStaticSpa(webDist, url.pathname);
      },
    });
    console.log(`Memkin HTTP API listening on http://localhost:${server.port}`);
    // Stdout contract for the Tauri shell: the URL after the marker is where the webview
    // navigates (the port may be OS-assigned, so report the real one — never hardcode).
    console.log(`MEMKIN_READY http://localhost:${server.port}`);
    if (
      shouldOpenBrowserOnServe({
        open: options.open !== false,
        mcp: !!options.mcp,
        mcpHttp: !!options.mcpHttp,
      })
    ) {
      openBrowser(`http://localhost:${server.port}`);
    }
    const activeScheduler = holder.current.scheduler;
    if (activeScheduler && config.scheduler?.enabled) {
      console.log(
        `Scheduler running — tick every ${config.scheduler.tick_interval_secs}s, sources: ${activeScheduler.getSourceIds().join(", ")}`,
      );
    }
    // Interactive terminals get a clear "what now?" banner so a running server doesn't
    // look frozen. Skipped when stdout is piped (e.g. the Tauri desktop sidecar), which
    // reads the MEMKIN_READY marker above instead.
    if (process.stdout.isTTY) {
      const u = `http://localhost:${server.port}`;
      console.log(
        `\n  ✅ Memkin is running — this window stays open to keep it live.\n` +
          `     • Open the app:  ${u}\n` +
          `     • Stop Memkin:   press Ctrl+C\n`,
      );
    }
  }
}

program
  .command("serve")
  .description("Start Memkin HTTP API or MCP stdio server")
  .option("-c, --config <path>", "Path to config file")
  .option("--mcp", "Run MCP stdio transport instead of HTTP")
  .option("--mcp-http", "Run MCP Streamable HTTP transport instead of the HTTP API")
  .option("--no-open", "Do not auto-open the browser after starting")
  .option(
    "--pglite-assets <dir>",
    "Directory holding bundled PGLite assets (compiled-sidecar mode; injected by the Tauri shell)",
  )
  .option(
    "--web-dist <dir>",
    "Directory holding the built web UI (compiled-sidecar mode; injected by the Tauri shell)",
  )
  .option(
    "--port <n>",
    "Override the HTTP port; 0 binds an OS-assigned free port (used by the Tauri shell)",
  )
  .option(
    "--host <host>",
    "Bind host for the HTTP API + Web UI (default 127.0.0.1, loopback only). " +
      "Binding a non-loopback host (e.g. 0.0.0.0) requires an auth token " +
      "(server.auth_token in config or MEMKIN_AUTH_TOKEN env), or the server refuses to start.",
  )
  .option("--mcp-bind <host>", "")
  .option("--mcp-port <port>", "", (v: string) => {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`--mcp-port: invalid number "${v}"`);
    return n;
  })
  .option("--mcp-read-write", "")
  .option(
    "--mcp-allowed-host <host>",
    "",
    (v: string, acc: string[]) => acc.concat(v),
    [] as string[],
  )
  .option("--daemon-instance-id <id>", "")
  .action((options) => {
    if (options.pgliteAssets) process.env.MEMKIN_PGLITE_ASSETS = options.pgliteAssets;
    if (options.webDist) process.env.MEMKIN_WEB_DIST = options.webDist;
    return runServe(options);
  });

async function runStart(options: { config?: string }): Promise<void> {
  const configPath = options.config ?? resolve(process.cwd(), "memkin.yaml");
  const plan = planStartup(existsSync(configPath));
  if (plan.runSetup) {
    console.log("No configuration found — launching setup wizard...");
    const { startSetupServer } = await import("./server/setup-server.js");
    await startSetupServer({
      configPath: options.config,
      larkBin: readLarkBinFromConfig(options.config),
    });
  }
  await runServe({ config: options.config });
}

program
  .command("start")
  .description("One-step launch: setup if needed, then serve + open browser")
  .option("-c, --config <path>", "Path to config file")
  .action((options) => runStart(options));

program.action(() => runStart({}));

function reportPlan(planned: PlannedClient[], verb: string, dryRun: boolean): void {
  if (planned.length === 0) {
    console.log(
      "No AI agents detected. Specify one with --agent <id> (claude-code, claude-desktop, cursor, codex, windsurf).",
    );
    return;
  }
  for (const client of planned) {
    console.log(`\n${verb} → ${client.displayName}:`);
    for (const op of client.ops) {
      const where = "path" in op ? op.path : `cli: ${op.args.join(" ")}`;
      console.log(`  - ${op.kind} ${op.action} ${where}`);
    }
  }
  if (!dryRun) console.log("\nRestart / reopen your agent for changes to take effect.");
}

program
  .command("install")
  .description("Register Memkin (MCP config + memory directive) into your AI agents")
  .option(
    "--agent <ids...>",
    "Target client(s): claude-code, claude-desktop, cursor, codex, windsurf (default: all detected)",
  )
  .option("--project", "Install into the current project instead of globally")
  .option("--http", "Register the Streamable HTTP transport instead of stdio")
  .option(
    "--url <url>",
    "Explicit MCP server URL for HTTP transport (default: http://127.0.0.1:<port>/mcp)",
  )
  .option("--port <port>", "MCP server port for HTTP transport URL (default: 3928)", (v) => {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`--port: invalid number "${v}"`);
    return n;
  })
  .option("--dry-run", "Preview changes without writing")
  .action((options) => {
    const scope = options.project ? "project" : "global";
    const planned = runInstall({
      agent: options.agent,
      scope,
      http: !!options.http,
      url: options.url as string | undefined,
      port: options.port as number | undefined,
      dryRun: !!options.dryRun,
    });
    reportPlan(planned, options.dryRun ? "Would install" : "Installed", !!options.dryRun);
  });

program
  .command("uninstall")
  .description("Remove Memkin MCP config + memory directive from your AI agents")
  .option("--agent <ids...>", "Target client(s) (default: all detected)")
  .option("--project", "Operate on the current project instead of globally")
  .option("--dry-run", "Preview changes without writing")
  .action((options) => {
    const scope = options.project ? "project" : "global";
    const planned = runUninstall({ agent: options.agent, scope, dryRun: !!options.dryRun });
    reportPlan(planned, options.dryRun ? "Would remove" : "Removed", !!options.dryRun);
  });

const hooksCmd = program
  .command("hooks")
  .description("Manage Claude Code hooks for automatic recall / write-back");

hooksCmd
  .command("install")
  .description("Install SessionStart + UserPromptSubmit (read) hooks; write-back is opt-in")
  .option("--write-back", "Also install the SessionEnd auto write-back hook (opt-in)")
  .option("--project", "Write to ./.claude/settings.json instead of the global one")
  .option("--dry-run", "Preview without writing")
  .action((options) => {
    const res = hooksInstall({
      writeBack: !!options.writeBack,
      project: !!options.project,
      dryRun: !!options.dryRun,
    });
    console.log(
      `${options.dryRun ? "Would install" : "Installed"} hooks [${res.events.join(", ")}] → ${res.path}`,
    );
    if (!options.writeBack) {
      console.log("Tip: add --write-back to also auto-capture memory at session end (opt-in).");
    }
    if (!options.dryRun) console.log("Reopen Claude Code for the hooks to take effect.");
  });

hooksCmd
  .command("uninstall")
  .description("Remove all Memkin hooks from settings.json")
  .option("--project", "Operate on ./.claude/settings.json instead of the global one")
  .option("--dry-run", "Preview without writing")
  .action((options) => {
    const res = hooksUninstall({ project: !!options.project, dryRun: !!options.dryRun });
    console.log(`${options.dryRun ? "Would remove" : "Removed"} Memkin hooks → ${res.path}`);
  });

const skillCmd = program.command("skill").description("Manage the Memkin agent skill");

skillCmd
  .command("scaffold")
  .description("Write the memkin skill (SKILL.md) into a skills directory")
  .option("--dir <path>", "Target skills directory (default: ./.claude/skills)")
  .action((options) => {
    const dir = options.dir ?? join(process.cwd(), ".claude", "skills");
    const path = scaffoldSkill(dir);
    console.log(`Wrote ${path}`);
  });

async function readStdinJson(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

program
  .command("hook <event>")
  .description("Internal: Claude Code hook entrypoint (session-start|user-prompt|session-end)")
  .action(async (event: string) => {
    try {
      const input = await readStdinJson();
      const config = loadConfig(undefined);
      const port = config.server.http_port;
      const out = await runHookEvent(event, input, {
        port,
        sessionContext: async () => {
          const stores = await createStores(config);
          try {
            return await getSessionContext(stores);
          } finally {
            await stores.db.close();
          }
        },
        ftsSearch: async (q, opts) => {
          const stores = await createStores(config);
          try {
            return await stores.search.search(q, opts);
          } finally {
            await stores.db.close();
          }
        },
      });
      if (out && Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
    } catch {
      // Never break the host session: emit nothing on any failure.
    }
    process.exit(0);
  });

program
  .command("search <query>")
  .description("Search Memkin memory")
  .option("-c, --config <path>", "Path to config file")
  .option("--mode <mode>", "Search mode (hybrid|fts)", "hybrid")
  .option("--limit <n>", "Limit results", "20")
  .action(async (query, options) => {
    const config = loadConfig(options.config);
    validateEnvForCommand(config, "search", { searchMode: options.mode });
    const stores = await createStores(config);
    const limit = Number(options.limit);
    const results =
      options.mode === "fts"
        ? await stores.search.search(query, { limit })
        : await stores.search.query(query, { limit });
    for (const result of results) {
      console.log(`${result.slug}\t${result.score.toFixed(4)}\t${result.snippet.slice(0, 200)}`);
    }
    await stores.db.close();
  });

program
  .command("embed")
  .description("Embed stale Memkin chunks")
  .option("-c, --config <path>", "Path to config file")
  .option("--limit <n>", "Limit chunks")
  .action(async (options) => {
    const config = loadConfig(options.config);
    validateEnvForCommand(config, "embed");
    const stores = await createStores(config);
    const result = await stores.embedding.embedStale({
      limit: options.limit ? Number(options.limit) : undefined,
    });
    console.log(`Embedded ${result.embedded} chunks, errors ${result.errors}`);
    await stores.db.close();
  });

/**
 * Obsidian sync — bidirectional export/import between PGLite and a vault.
 * See docs/specs/memkin-2026-06-04-obsidian-sync.md
 */
program
  .command("export")
  .description("Export Memkin pages to an Obsidian vault (Markdown)")
  .requiredOption("--vault <path>", "Obsidian vault directory")
  .option("--force", "Ignore hash comparison, overwrite all files")
  .option("--dry-run", "Print intended actions without writing")
  .option("-c, --config <path>", "Path to config file")
  .action(async (options) => {
    const { exportToVault } = await import("./sync/obsidian.js");
    const stores = await createStores(loadConfig(options.config));
    try {
      const result = await exportToVault(stores, options.vault, {
        force: options.force,
        dryRun: options.dryRun,
      });
      console.log(
        `Exported: ${result.written} written, ${result.skipped} skipped, ${result.errors.length} errors`,
      );
      for (const err of result.errors) {
        console.error(`  error: ${err.slug}: ${err.reason}`);
      }
      if (options.dryRun) console.log("(dry-run: no files written)");
    } finally {
      await stores.db.close();
    }
  });

program
  .command("import")
  .description("Import an Obsidian vault back into Memkin")
  .requiredOption("--vault <path>", "Obsidian vault directory")
  .option("--force", "Ignore hash comparison, import all files")
  .option("--dry-run", "Print intended actions without writing")
  .option(
    "--strict-conflict",
    "Skip files where DB has changed since last sync instead of overwriting",
  )
  .option("-c, --config <path>", "Path to config file")
  .action(async (options) => {
    const { importFromVault } = await import("./sync/obsidian.js");
    const stores = await createStores(loadConfig(options.config));
    try {
      const result = await importFromVault(stores, options.vault, {
        force: options.force,
        dryRun: options.dryRun,
        strictConflict: options.strictConflict,
      });
      console.log(
        `Imported: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`,
      );
      for (const w of result.warnings) {
        console.warn(`  warn: ${w.slug}: ${w.reason}`);
      }
      for (const err of result.errors) {
        console.error(`  error: ${err.file}: ${err.reason}`);
      }
      if (!options.dryRun && result.imported > 0) {
        console.log("Tip: Run 'memkin embed' to update embeddings for changed pages.");
      }
    } finally {
      await stores.db.close();
    }
  });

program
  .command("consolidate")
  .description("Run memory lifecycle tier rotation (hot→warm and/or warm→cold)")
  .option("-c, --config <path>", "Path to config file (default: memkin.yaml)")
  .option("--hot", "Run hot→warm rotation only")
  .option("--warm", "Run warm→cold rotation only (requires LLM API key)")
  .option("--dry-run", "Report what would be consolidated without writing")
  .action(async (options) => {
    try {
      const config = loadConfig(options.config);
      const stores = await createStores(config);

      let llmProvider: ReturnType<typeof createLLMProvider> | undefined;
      if (options.warm || (!options.hot && !options.warm)) {
        const llmConfig = config.llm;
        const envKey =
          llmConfig.provider === "anthropic"
            ? process.env.ANTHROPIC_API_KEY
            : process.env.OPENAI_API_KEY;
        const apiKey = llmConfig.api_key ?? envKey;
        if (apiKey) {
          if (!llmConfig.api_key) llmConfig.api_key = apiKey;
          llmProvider = createLLMProvider(llmConfig);
        } else if (options.warm) {
          // Explicit --warm with no LLM key: fail fast
          console.error(
            "Error: --warm requires an LLM API key. Set ANTHROPIC_API_KEY or configure api_key in memkin.yaml.",
          );
          process.exit(1);
        } else {
          // Full run with no LLM: skip warm→cold, run hot only
          console.warn(
            "Warning: no LLM API key found. Running hot→warm only. " +
              "Set ANTHROPIC_API_KEY to enable warm→cold consolidation.",
          );
        }
      }

      const consolidator = new Consolidator(
        {
          pages: stores.pages,
          graph: stores.graph,
          tags: stores.tags,
          timeline: stores.timeline,
          entitySuggestions: new EntityMergeSuggestionStore(stores.db.executor),
        },
        llmProvider,
        {
          profile: config.profile,
          profileStores: {
            pages: stores.pages,
            graph: stores.graph,
            timeline: stores.timeline,
            behavior: new PersonBehaviorStore(stores.db.executor),
          },
        },
        {
          payloads: new DistilledPayloadStore(stores.db.executor),
          ttlDays: config.distiller.payload_ttl_days,
        },
      );

      const mode: ConsolidateMode = options.hot
        ? "hot"
        : options.warm
          ? "warm"
          : llmProvider
            ? "all"
            : "hot"; // fall back to hot-only when full run has no LLM
      const dryRun = options.dryRun ?? false;

      if (dryRun) console.log("DRY-RUN mode — no writes will occur\n");

      const result = await consolidator.runOnce(mode, dryRun);

      console.log("Consolidation complete:");
      console.log(`  hot→warm pages moved:    ${result.hotToWarm}`);
      console.log(`  warm→cold pages archived: ${result.warmToCold}`);
      console.log(`  dead links checked:       ${result.deadLinksChecked}`);
      console.log(`  preferences inferred:     ${result.preferencesInferred}`);
      console.log(`  profiles synthesized:     ${result.profilesSynthesized}`);
      console.log(`  entity merge suggestions: ${result.entityMergeSuggestions}`);
      console.log(`  distilled payloads swept: ${result.payloadsSwept}`);

      await stores.db.close();
    } catch (error) {
      console.error("Consolidate failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ── Person identity (Layer 1: aliases / merge / rename) ────────────────────
const HANDLE_KINDS: HandleKind[] = ["feishu_open_id", "email", "name", "nickname", "slug"];

const identityCmd = program
  .command("identity")
  .description("Manage person identity: aliases, merge, and rename");

identityCmd
  .command("alias <canonical_slug> <kind> <value>")
  .description(`Attach an alias/handle to a person. kind: ${HANDLE_KINDS.join(" | ")}`)
  .option("-c, --config <path>", "Path to config file")
  .option("--strong", "Force strong strength (auto-resolvable)")
  .option("--weak", "Force weak strength (explicit-only)")
  .action(async (canonicalSlug, kind, value, options) => {
    if (!HANDLE_KINDS.includes(kind as HandleKind)) {
      console.error(`Error: invalid kind '${kind}'. Expected one of: ${HANDLE_KINDS.join(", ")}`);
      process.exit(1);
    }
    const { db, identity } = await openIdentityStore(loadConfig(options.config));
    try {
      const strength = options.strong ? "strong" : options.weak ? "weak" : undefined;
      await identity.addAlias(canonicalSlug, kind as HandleKind, value, strength);
      console.log(`Linked ${kind}:${value} → ${canonicalSlug}`);
      for (const h of await identity.listHandles(canonicalSlug)) {
        console.log(`  ${h.kind}\t${h.value}\t(${h.strength})`);
      }
    } catch (error) {
      console.error("alias failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      await db.close();
    }
  });

identityCmd
  .command("handles <canonical_slug>")
  .description("List all handles/aliases attached to a person")
  .option("-c, --config <path>", "Path to config file")
  .action(async (canonicalSlug, options) => {
    const { db, identity } = await openIdentityStore(loadConfig(options.config));
    try {
      const handles = await identity.listHandles(canonicalSlug);
      if (handles.length === 0) {
        console.log(`No handles for ${canonicalSlug}`);
      } else {
        for (const h of handles) console.log(`${h.kind}\t${h.value}\t(${h.strength})`);
      }
    } finally {
      await db.close();
    }
  });

identityCmd
  .command("merge <from> <into>")
  .description("Merge person page <from> into <into> (re-points links/timeline/tags + aliases)")
  .option("-c, --config <path>", "Path to config file")
  .action(async (from, into, options) => {
    const { db, identity } = await openIdentityStore(loadConfig(options.config));
    try {
      await identity.merge(from, into);
      console.log(`Merged ${from} → ${into}`);
      console.log("Note: run `memkin embed` to re-embed the folded content.");
    } catch (error) {
      console.error("merge failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      await db.close();
    }
  });

identityCmd
  .command("rename <from> <to>")
  .description("Rename a person's canonical slug (correct a wrong canonicalization)")
  .option("-c, --config <path>", "Path to config file")
  .action(async (from, to, options) => {
    const { db, identity } = await openIdentityStore(loadConfig(options.config));
    try {
      await identity.recanonicalize(from, to);
      console.log(`Renamed ${from} → ${to}`);
    } catch (error) {
      console.error("rename failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      await db.close();
    }
  });

const docsCmd = program.command("docs").description("Feishu doc summary cards (DocSource v2)");

docsCmd
  .command("sync")
  .description("Scan Feishu docs, build pointer cards, upgrade triggered docs to full cards")
  .option("-c, --config <path>", "Path to config file (default: memkin.yaml)")
  .action(async (options) => {
    try {
      const config = loadConfig(options.config);
      ensureStateDir(config.__context.projectRoot);
      const feishu = config.sources.feishu;
      if (!feishu?.enabled || !feishu.sources?.docs?.enabled) {
        console.error(
          "Feishu docs source is not enabled in config (sources.feishu.sources.docs.enabled).",
        );
        process.exit(1);
      }
      const stores = await createStores(config);
      const client = new LarkCliHttpClient(feishu.lark_bin);
      const docsConfig = normalizeDocsConfig(feishu.sources.docs);

      // self_open_id: config override else resolve via lark-cli whoami helper used elsewhere
      const selfOpenId =
        docsConfig.self_open_id ??
        (await resolveSelfOpenId(client, feishu.sources?.dm?.self_open_id)) ??
        "";

      const llmConfig = { ...config.llm };
      if (docsConfig.llm.model) llmConfig.model = docsConfig.llm.model;
      const envKey =
        llmConfig.provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;
      if (!llmConfig.api_key && envKey) llmConfig.api_key = envKey;
      const provider = llmConfig.api_key
        ? createLLMProvider(llmConfig)
        : createMockProvider(new Map());

      const cursor = new CursorStore(statePath("cursors.yaml", config.__context.projectRoot));
      cursor.load();

      // Identity layer for canonicalizing action_item owners → person slugs and
      // detecting self-ownership, so doc/meeting action_items become task signals
      // the daily report can surface (Spec 9 §3.3).
      const identity = new PersonIdentityStore(
        stores.db.executor,
        { pages: stores.pages },
        { behavior: new PersonBehaviorStore(stores.db.executor) },
      );

      const stats = await runDocSource({
        client,
        stores,
        provider,
        config: docsConfig,
        cursor,
        selfOpenId,
        nowMs: Date.now(),
        nowIso: () => new Date().toISOString(),
        actionItemDeps: {
          graph: stores.graph,
          resolveOwner: async (ownerRaw) => {
            if (!ownerRaw) return null;
            // best-effort: map a name/@mention to a canonical person slug
            return (
              (await identity.resolveHandle("name", ownerRaw)) ??
              (await identity.resolveHandle("nickname", ownerRaw)) ??
              null
            );
          },
          isMe: (slug) => identity.isMe(slug),
        },
      });

      console.log(
        `[docs] scanned=${stats.candidates_scanned} pointer=${stats.pointer_saved} full=${stats.full_card_generated} skipped=${stats.skipped} queue=${stats.upgrade_queue_size} llm_failed=${stats.llm_failed}`,
      );
      await stores.db.close();
    } catch (error) {
      console.error("docs sync failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

docsCmd
  .command("status")
  .description("Show Feishu doc card counts")
  .option("-c, --config <path>", "Path to config file")
  .option("--failed", "List cards whose last extraction failed")
  .action(async (options) => {
    try {
      const config = loadConfig(options.config);
      const stores = await createStores(config);
      const pages = await stores.pages.listPages({ type: "feishu_doc_card", limit: 100000 });
      if (options.failed) {
        for (const f of failedCards(pages as never)) console.log(`${f.doc_token}\t${f.error}`);
      } else {
        const s = summarizeCards(pages as never);
        console.log(`total=${s.total} full=${s.full} pointer=${s.pointer} failed=${s.failed}`);
      }
      await stores.db.close();
    } catch (error) {
      console.error("docs status failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

docsCmd
  .command("retry [doc_token]")
  .description("Retry full-card extraction for a failed doc (or --all-failed)")
  .option("-c, --config <path>", "Path to config file")
  .option("--all-failed", "Retry every card with an extract_error")
  .action(async (docToken, options) => {
    try {
      const config = loadConfig(options.config);
      const feishu = config.sources.feishu;
      if (!feishu?.sources?.docs?.enabled) {
        console.error("Feishu docs source not enabled.");
        process.exit(1);
      }
      const stores = await createStores(config);
      const client = new LarkCliHttpClient(feishu.lark_bin);
      const docsConfig = normalizeDocsConfig(feishu.sources.docs);
      const llmConfig = { ...config.llm };
      if (docsConfig.llm.model) llmConfig.model = docsConfig.llm.model;
      const envKey =
        llmConfig.provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;
      if (!llmConfig.api_key && envKey) llmConfig.api_key = envKey;
      const provider = llmConfig.api_key
        ? createLLMProvider(llmConfig)
        : createMockProvider(new Map());
      const builder = new FullCardBuilder(client, provider, docsConfig.llm.model ?? "unknown", () =>
        new Date().toISOString(),
      );

      const tokens: string[] = [];
      if (options.allFailed) {
        const pages = await stores.pages.listPages({ type: "feishu_doc_card", limit: 100000 });
        for (const f of failedCards(pages as never)) tokens.push(f.doc_token);
      } else if (docToken) {
        tokens.push(docToken);
      } else {
        console.error("Provide a doc_token or --all-failed.");
        process.exit(1);
      }

      for (const token of tokens) {
        const existing = await loadExistingCard(stores, token);
        if (!existing) {
          console.warn(`skip ${token}: no existing card`);
          continue;
        }
        // retry intentionally re-evaluates the gate (no force); short/empty docs
        // stay pointers by design — unlike MCP ingest which forces.
        const card = await builder.build(existing);
        await writeCard(stores, card);
        if (card.extract_level === "pointer") {
          const reason = card.extract_error ?? card.extract_skipped ?? "unknown";
          console.log(`${token}: pointer (not upgraded — ${reason})`);
        } else {
          console.log(`${token}: full`);
        }
      }
      await stores.db.close();
    } catch (error) {
      console.error("docs retry failed:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// SP4 — always-on daemon commands
// ---------------------------------------------------------------------------

program
  .command("up")
  .description("Start the always-on Memkin daemon and wire detected AI agents")
  .option("-c, --config <path>", "Path to config file (default: memkin.yaml)")
  .option("--port <n>", "Override MCP HTTP port", (v) => {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`--port: invalid number "${v}"`);
    return n;
  })
  .option("--linger", "Enable systemd --linger so the service survives logout (Linux only)")
  .action(async (options) => {
    try {
      const result = await runUp({
        config: options.config as string | undefined,
        port: options.port as number | undefined,
        linger: !!options.linger,
      });
      console.log(`✓ Memkin daemon running`);
      console.log(`  URL:    ${result.url}`);
      console.log(`  Port:   ${result.port}`);
      console.log(`  Engine: ${result.engine}`);
      if (result.wiredAgents.length > 0) {
        console.log(`  Wired:  ${result.wiredAgents.join(", ")}`);
      }
      if (result.skippedAgents.length > 0) {
        for (const s of result.skippedAgents) {
          console.log(`  Skipped: ${s.id} — ${s.reason}`);
        }
      }
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    } catch (err) {
      console.error("memkin up failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("down")
  .description("Stop the always-on daemon and remove its autostart entry")
  .action(async () => {
    const h = homedir();
    const plat = process.platform;
    try {
      // Best-effort config load to detect engine; safe to fail (down works without a config)
      let engine: string | undefined;
      try {
        const cfg = loadConfig();
        engine = cfg.store.engine;
      } catch {
        // no config or parse error — treat engine as unknown (non-managed)
      }

      const result = await down({
        home: h,
        platform: plat,
        acquireLock: acquireLifecycleLock,
        disable: () =>
          disableAutostart({
            platform: plat,
            home: h,
            runner: nodeRunner,
            keepStateOnBootoutFailure: true,
          }),
        engine,
        stopManagedPg: () => stopManagedFromState(h, nodeRunner).then(() => undefined),
      });
      console.log(result.stopped ? `✓ ${result.note}` : `✗ ${result.note}`);
    } catch (err) {
      console.error("memkin down failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("autostart <action>")
  .description("Manage daemon autostart entry (action: enable | disable | status)")
  .option("-c, --config <path>", "Path to config file (required for enable)")
  .option("--port <n>", "Override MCP HTTP port (for enable)", (v) => {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`--port: invalid number "${v}"`);
    return n;
  })
  .action(async (action: string, options) => {
    const h = homedir();
    const plat = process.platform;
    try {
      if (action === "enable") {
        // Delegate fully to runUp which handles all the state-building
        await runUp({
          config: options.config as string | undefined,
          port: options.port as number | undefined,
        });
        console.log("✓ Autostart enabled.");
      } else if (action === "disable") {
        const res = await disableAutostart({ platform: plat, home: h, runner: nodeRunner });
        if (res.launcherCode && res.launcherCode !== 0) {
          console.warn(
            `Launcher returned non-zero (${res.launcherCode}): ${res.launcherStderr ?? ""}`,
          );
        }
        console.log("✓ Autostart disabled.");
      } else if (action === "status") {
        const st = await statusAutostart({ platform: plat, home: h, runner: nodeRunner });
        console.log("Desired state:", st.desired ? JSON.stringify(st.desired, null, 2) : "(none)");
        console.log(`Launcher output:\n${st.raw}`);
      } else {
        console.error(`Unknown autostart action "${action}". Use: enable | disable | status`);
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `memkin autostart ${action} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show the current state of the always-on daemon")
  .action(async () => {
    const h = homedir();
    const stateDir = join(h, ".memkin");
    const stored = readDaemonState(stateDir);

    let health: { status: number; body: Record<string, unknown> } | null = null;
    if (stored?.url) {
      try {
        const healthUrl = stored.url.replace(/\/mcp$/, "/health");
        const r = await fetch(healthUrl);
        health = {
          status: r.status,
          body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
        };
      } catch {
        health = null;
      }
    }

    let currentRawHash: string | null = null;
    let currentServingHash: string | null = null;
    if (stored?.config_path) {
      try {
        currentRawHash = rawYamlHash(stored.config_path);
        const cfg = loadConfig(stored.config_path);
        // Same helper `up` stores its hash from — recomputing from bare config
        // (read_only: true by default) made the drift warning permanent.
        const rt = resolveDaemonLaunchRuntime(cfg.mcp.http);
        currentServingHash = servingSubsetHash({
          bind: rt.bind,
          port: rt.port,
          readOnly: rt.readOnly,
          hosts: rt.allowedHosts,
        });
      } catch {
        // config unreadable
      }
    }

    const report = computeStatus({ stored, currentRawHash, currentServingHash, health });

    console.log(`Status: ${report.running ? "running ✓" : "stopped ✗"}`);
    if (report.url) console.log(`URL:    ${report.url}`);
    if (report.pid) console.log(`PID:    ${report.pid}`);
    if (report.engine) console.log(`Engine: ${report.engine}`);
    if (report.configPath) console.log(`Config: ${report.configPath}`);
    if (report.drift.configChanged)
      console.log("⚠ Config changed since last up — run `memkin up` to apply.");
    if (report.drift.needsReup)
      console.log("⚠ Serving subset changed — run `memkin up` to re-register agents.");
    if (report.drift.restartedOntoEditedConfig)
      console.log("⚠ Daemon restarted onto edited config.");

    // Show managed Postgres state when engine is managed
    const managedState = readManagedState(managedPaths(h, "17"));
    if (managedState) {
      // Lightweight pg_ctl status probe — run if pg_ctl is available
      let clusterRunning: boolean | null = null;
      try {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync(managedState.pgCtlPath, ["status", "-D", managedState.pgdata], {
          encoding: "utf8",
          timeout: 3000,
        });
        // pg_ctl status exits 0 if running, non-zero if stopped/no data dir
        clusterRunning = result.status === 0;
      } catch {
        clusterRunning = null;
      }
      const managedLines = formatManagedStatus(managedState, clusterRunning);
      console.log("");
      for (const line of managedLines) {
        console.log(`${line.label}: ${line.value}`);
      }
    }
  });

program.parse(process.argv);
