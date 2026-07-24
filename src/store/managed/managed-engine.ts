import { homedir } from "node:os";
import type { Config } from "../../core/config.js";
import { Database } from "../database.js";
import { checkManagedHostSupport, type HostSupport } from "./host-support.js";
import { withManagedLock } from "./managed-lock.js";
import { managedConnUrl, managedPaths } from "./pg-paths.js";
import type { PgRuntimeProvider, RuntimePaths } from "./pg-runtime-provider.js";

export interface ManagedSupervisor {
  ensureUp(): Promise<void>;
  /** Returns the current Postgres process state. */
  status(): Promise<"running" | "stopped">;
  /** Restarts Postgres if it is down; returns true if a restart was performed. */
  restartIfDown(): Promise<boolean>;
  /** Stops internal monitoring resources (does NOT stop the cluster). */
  dispose(): void;
}

export interface ProvisionDeps {
  home?: string;
  provider: PgRuntimeProvider;
  makeSupervisor: (rt: RuntimePaths, home: string) => ManagedSupervisor;
  /** Override the host preflight (tests). Default: real checkManagedHostSupport. */
  hostSupport?: () => HostSupport;
}

export interface ProvisionResult {
  supervisor: ManagedSupervisor;
  pgConfig: Config;
}

export async function provisionManaged(
  config: Config,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  // Preflight BEFORE any download/initdb so a host that provably can't run the
  // runtime (root, old glibc, unsupported platform) gets one actionable error
  // instead of a raw initdb/loader failure. "soft-no" (undeterminable glibc)
  // proceeds: an explicitly configured engine is never blocked on uncertainty.
  const support = (
    deps.hostSupport ??
    (() => checkManagedHostSupport({ platform: process.platform, arch: process.arch }))
  )();
  if (support.level === "hard-no") {
    throw new Error(`managed Postgres preflight failed: ${support.reason}`);
  }

  const home = deps.home ?? homedir();
  return withManagedLock(home, async () => {
    const rt = await deps.provider.ensure();
    const supervisor = deps.makeSupervisor(rt, home);
    await supervisor.ensureUp();
    const paths = managedPaths(home, rt.pgMajor);
    const pgConfig: Config = {
      ...config,
      store: {
        ...(config.store ?? {}),
        engine: "postgres" as const,
        database_url: managedConnUrl(paths),
        pool_size: config.store?.pool_size,
        data_dir: undefined,
      },
    };
    return { supervisor, pgConfig };
  });
}

export interface ForegroundProvisionDeps extends ProvisionDeps {
  /** Override Database.create — used in tests to avoid a real Postgres connection. */
  dbCreate?: typeof Database.create;
}

/**
 * Full foreground provision: provision the managed Postgres cluster, then run a
 * complete Database.create (schema + migrations) and close. This ensures all
 * heavy work (download, initdb, start, bootstrapRoles, finalizeHba, schema,
 * migrations) is complete BEFORE the daemon autostart is enabled, keeping the
 * daemon's own ensureUp on a fast warm-path.
 */
export async function provisionManagedForeground(
  config: Config,
  deps: ForegroundProvisionDeps,
): Promise<void> {
  const { pgConfig } = await provisionManaged(config, deps);
  const dbCreate = deps.dbCreate ?? Database.create.bind(Database);
  const db = await dbCreate(pgConfig, {
    embeddingDimensions: config.embedding?.dimensions,
  });
  await db.close();
}
