import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoadedConfig } from "../core/config.js";
import { loadConfig } from "../core/config.js";
import type { DaemonRuntime } from "../daemon/autostart/argv.js";
import { detectDaemonRuntime, resolveDaemonArgv } from "../daemon/autostart/argv.js";
import type { DaemonState } from "../daemon/autostart/daemon-state.js";
import {
  rawYamlHash,
  readDaemonState,
  servingSubsetHash,
  writeDaemonState,
} from "../daemon/autostart/daemon-state.js";
import { disableAutostart, enableAutostart } from "../daemon/autostart/index.js";
import type { CommandRunner } from "../daemon/autostart/runner.js";
import { nodeRunner } from "../daemon/autostart/runner.js";
import { ADAPTERS, detectInstalledAgents, planInstall, runInstall } from "../install/index.js";
import { resolveDaemonLaunchRuntime } from "../server/mcp-http-runtime.js";
import { provisionManagedForeground as realProvisionManagedForeground } from "../store/managed/managed-engine.js";
import { managedPaths } from "../store/managed/pg-paths.js";
import { createPgRuntimeProvider } from "../store/managed/pg-runtime-provider.js";
import { createPgSupervisor } from "../store/managed/pg-supervisor.js";
import { pollHealth } from "./health-poll.js";
import { recordOriginal } from "./install-state.js";
import { acquireLifecycleLock } from "./lifecycle-lock.js";
import { bringUpDaemon, planUp, wireAgents } from "./up.js";

export interface RunUpOptions {
  port?: number; // override mcp port
  config?: string; // path to memkin.yaml
  linger?: boolean; // systemd --linger (linux)
}

export interface RunUpInjected {
  runner?: CommandRunner;
  fetchHealthImpl?: (url: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Override daemon runtime detection — useful in tests where no binary/dist exists. */
  daemonRuntime?: DaemonRuntime;
  /**
   * Override the managed-Postgres foreground provision step. Injected in tests to
   * avoid spinning up a real Postgres cluster. In production this is omitted and the
   * real provisionManagedForeground is called with live provider/supervisor deps.
   */
  provisionManagedForeground?: (config: LoadedConfig) => Promise<void>;
}

export interface RunUpResult {
  url: string;
  port: number;
  engine: string;
  wiredAgents: string[];
  skippedAgents: Array<{ id: string; reason: string }>;
  warnings: string[];
}

export async function runUp(
  opts: RunUpOptions = {},
  injected: RunUpInjected = {},
): Promise<RunUpResult> {
  const home = injected.home ?? homedir();
  const platform = injected.platform ?? process.platform;
  const runner = injected.runner ?? nodeRunner;
  const fetchHealthImpl = injected.fetchHealthImpl ?? defaultFetchHealth;

  // Step 1: acquire lifecycle lock
  const lock = acquireLifecycleLock(home, "up");
  try {
    // Step 2: load config
    const config = loadConfig(opts.config);
    const configPath = config.__context.configPath;
    const missingEnvVars = config.__context.missingEnvVars;
    const engine = config.store.engine ?? "pglite";

    // Step 2a: foreground managed-Postgres provision (P0-3/P0-4)
    // Must run BEFORE bringUpDaemon/enableAutostart so the daemon's ensureUp is a fast warm-path.
    if (engine === "managed") {
      const provisionFn =
        injected.provisionManagedForeground ??
        ((cfg: LoadedConfig) =>
          realProvisionManagedForeground(cfg, {
            home,
            provider: createPgRuntimeProvider({
              home,
              pgMajor: "17",
              runtimeDir: cfg.store?.managed?.runtime_dir,
            }),
            makeSupervisor: (rt, h) =>
              createPgSupervisor({
                runtime: rt,
                paths: managedPaths(h, rt.pgMajor),
                runner,
              }),
          }));
      await provisionFn(config);
    }

    // Step 3: detected agents mapped to {id, supportsHttp}
    const detectedIds = detectInstalledAgents(home, platform);
    const detectedAgents = detectedIds.map((id) => {
      const adapter = ADAPTERS.find((a) => a.id === id);
      return { id, supportsHttp: adapter?.supportsHttp ?? false };
    });

    // Step 4: plan
    const plan = planUp({ detectedAgents, missingEnvVars, engine });

    // Step 5: resolve the runtime exactly as the daemon will be launched
    // (loopback, read-write). `status` recomputes its hash from this same
    // helper, so the two sides stay in agreement.
    const runtime = resolveDaemonLaunchRuntime(config.mcp.http, { port: opts.port });
    const port = runtime.port;
    const url = `http://127.0.0.1:${port}/mcp`;

    // Step 6: instance ID
    const instanceId = randomUUID();

    // Step 7: frozen argv
    const rt = injected.daemonRuntime ?? detectDaemonRuntime();
    const serveTail = [
      "serve",
      "--mcp-http",
      "--no-open",
      "--config",
      configPath,
      "--mcp-bind",
      runtime.bind,
      "--mcp-port",
      String(port),
      "--mcp-read-write",
      "--daemon-instance-id",
      instanceId,
      ...runtime.allowedHosts.flatMap((h) => ["--mcp-allowed-host", h]),
    ];
    const argv = resolveDaemonArgv(rt, serveTail);

    // Step 8: extract secret env vars from raw yaml
    const env = extractSecretEnv(configPath);

    // Step 9: build DaemonState
    const state: DaemonState = {
      instance_id: instanceId,
      config_path: configPath,
      raw_yaml_hash: rawYamlHash(configPath),
      serving_subset_hash: servingSubsetHash({
        bind: runtime.bind,
        port,
        readOnly: runtime.readOnly,
        hosts: runtime.allowedHosts,
      }),
      url,
      argv,
    };

    // Step 10: read prior state
    const stateDir = join(home, ".memkin");
    const priorState = readDaemonState(stateDir);
    const reconcile = priorState !== null;

    // Snapshot for restore: read current service file text if it exists
    type Snapshot = { serviceFileText: string | null; daemonJson: DaemonState | null };
    let savedSnapshot: Snapshot | null = null;

    const serviceFilePath =
      platform === "darwin"
        ? join(home, "Library", "LaunchAgents", "com.memkin.daemon.plist")
        : join(home, ".config", "systemd", "user", "memkin.service");

    // Step 11: bringUpDaemon
    await bringUpDaemon({
      priorState,
      saveOld: async (): Promise<Snapshot> => {
        const serviceFileText = existsSync(serviceFilePath)
          ? readFileSync(serviceFilePath, "utf8")
          : null;
        savedSnapshot = { serviceFileText, daemonJson: priorState };
        return savedSnapshot;
      },
      enable: () => enableAutostart({ platform, home, runner, state, env, linger: opts.linger }),
      pollReady: () =>
        pollHealth(
          () => fetchHealthImpl(url),
          { instanceId, port, bind: "127.0.0.1", engine },
          { timeoutMs: 10_000 },
        ),
      disable: () => disableAutostart({ platform, home, runner }).then(() => undefined),
      restoreOld: async (saved: unknown) => {
        // BEST-EFFORT restore: evict failed new service, re-write saved service file + daemon.json then reactivate
        // FIX 2: bootout the failed new service before restoring old
        await disableAutostart({ platform, home, runner }).catch(() => {});
        const snap = saved as Snapshot;
        if (snap.serviceFileText !== null) {
          writeFileSync(serviceFilePath, snap.serviceFileText, "utf8");
          // FIX 1: ensure restored service file is also 0600
          chmodSync(serviceFilePath, 0o600);
        }
        if (snap.daemonJson !== null) {
          writeDaemonState(stateDir, snap.daemonJson);
          // Best-effort re-activate (fire & forget — we're already in an error path)
          await enableAutostart({
            platform,
            home,
            runner,
            state: snap.daemonJson,
            env: {},
          }).catch(() => {});
        }
      },
    });

    // Step 12: wire agents
    // In-memory before-image map: agentId -> {path, beforeText}
    const beforeImages = new Map<string, Array<{ path: string; beforeText: string | null }>>();

    await wireAgents({
      plan: plan.wire,
      reconcile,
      writeAgent: async (agent) => {
        // Capture before-image of agent's mcp config files via a dry-run plan
        const agentImages = captureBeforeImage(agent.id, home, platform, url);
        beforeImages.set(agent.id, agentImages);
        // FIX 3: record Layer-1 backup (first-backup-wins) before mutating
        recordBeforeInstall(agent.id, home, platform, url, agentImages);
        // Run install for this agent via HTTP transport
        runInstall({ agent: [agent.id], http: true, url, home, platform });
      },
      rollbackToBeforeImage: async () => {
        for (const images of beforeImages.values()) {
          for (const img of images) {
            if (img.beforeText === null) {
              // file didn't exist before — remove it if it now exists
              try {
                if (existsSync(img.path)) {
                  const { unlinkSync } = await import("node:fs");
                  unlinkSync(img.path);
                }
              } catch {
                /* best-effort */
              }
            } else {
              try {
                writeFileSync(img.path, img.beforeText, "utf8");
              } catch {
                /* best-effort */
              }
            }
          }
        }
      },
      restoreOldDaemon: async () => {
        if (savedSnapshot) {
          // FIX 2: bootout the currently-loaded (failed new) service before restoring old
          await disableAutostart({ platform, home, runner }).catch(() => {});
          if (savedSnapshot.serviceFileText !== null) {
            writeFileSync(serviceFilePath, savedSnapshot.serviceFileText, "utf8");
            // FIX 1: ensure restored service file is also 0600
            chmodSync(serviceFilePath, 0o600);
          }
          if (savedSnapshot.daemonJson !== null) {
            writeDaemonState(stateDir, savedSnapshot.daemonJson);
            await enableAutostart({
              platform,
              home,
              runner,
              state: savedSnapshot.daemonJson,
              env: {},
            }).catch(() => {});
          }
        }
      },
    });

    return {
      url,
      port,
      engine,
      wiredAgents: plan.wire.map((a) => a.id),
      skippedAgents: plan.skip.map((a) => ({
        id: a.id,
        reason: "stdio-only agent (pglite engine)",
      })),
      warnings: plan.warnings,
    };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch /health from the daemon. Not injected in production — only overridden in tests. */
async function defaultFetchHealth(
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const healthUrl = url.replace(/\/mcp$/, "/health");
  const r = await fetch(healthUrl);
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body };
}

/** Extract secret env var names from raw YAML text (${VAR_NAME} references) that are present in process.env. */
function extractSecretEnv(configPath: string): Record<string, string> {
  try {
    const raw = readFileSync(configPath, "utf8");
    const matches = [...raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)];
    const env: Record<string, string> = {};
    for (const m of matches) {
      const name = m[1];
      const val = process.env[name];
      if (val !== undefined) env[name] = val;
    }
    return env;
  } catch {
    return {};
  }
}

/** Capture before-image of the agent's mcp config files by doing a dry-run plan. */
function captureBeforeImage(
  agentId: string,
  home: string,
  platform: NodeJS.Platform,
  url: string,
): Array<{ path: string; beforeText: string | null }> {
  try {
    const planned = planInstall({ agent: [agentId], http: true, url, home, platform }, "upsert");
    const images: Array<{ path: string; beforeText: string | null }> = [];
    for (const client of planned) {
      for (const op of client.ops) {
        if ("path" in op && op.path) {
          const beforeText = existsSync(op.path) ? readFileSync(op.path, "utf8") : null;
          images.push({ path: op.path, beforeText });
        }
      }
    }
    return images;
  } catch {
    return [];
  }
}

/**
 * FIX 3: Record Layer-1 backup (install-state.json) for all ops of an agent BEFORE mutating.
 * managedHash is a hash of the memkin MCP entry content that will be written (used by
 * restorableOriginal to detect post-install hand-edits).
 */
function recordBeforeInstall(
  agentId: string,
  home: string,
  platform: NodeJS.Platform,
  url: string,
  beforeImages: Array<{ path: string; beforeText: string | null }>,
): void {
  try {
    const planned = planInstall({ agent: [agentId], http: true, url, home, platform }, "upsert");
    // Build a lookup of path → beforeText for quick access
    const imageMap = new Map(beforeImages.map((img) => [img.path, img.beforeText]));
    for (const client of planned) {
      for (const op of client.ops) {
        if (!("path" in op) || !op.path) continue; // skip cli ops
        const opRef = {
          client: agentId,
          scope: "global" as const,
          path: op.path,
          op_kind: op.kind,
        };
        const beforeText = imageMap.get(op.path) ?? null;
        const present = beforeText !== null;
        // managedHash: hash of the entry that is about to be written
        const entryContent =
          "entry" in op && op.entry
            ? JSON.stringify(op.entry)
            : "content" in op && op.content
              ? op.content
              : op.path;
        const managedHash = createHash("sha256").update(entryContent).digest("hex");
        recordOriginal(home, opRef, { present, raw: beforeText }, managedHash);
      }
    }
  } catch {
    // best-effort — Layer-1 backup is non-fatal
  }
}
