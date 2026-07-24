import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { managedPaths } from "./pg-paths.js";

export interface RuntimePaths {
  root: string;
  pgMajor: string;
  bin: string;
  postgres: string;
  pgCtl: string;
  initdb: string;
  createdb: string;
  pgIsReady: string;
  libDir: string; // <root>/lib/postgresql
  extensionDir: string; // <root>/share/postgresql/extension
}

export interface PgRuntimeProvider {
  ensure(): Promise<RuntimePaths>;
  verify(): Promise<RuntimePaths>;
}

export interface ProviderOptions {
  home: string;
  pgMajor: string;
  runtimeDir?: string; // from store.managed.runtime_dir (overrides env if set)
}

// ---------------------------------------------------------------------------
// Pinned manifest — bump when republishing the runtime tarball
//
// Keyed by `${platform}-${arch}` (NOT arch alone) because the tarball layout
// and shared-library extension differ by platform (darwin → .dylib via
// install_name_tool/@rpath, linux → .so via patchelf/$ORIGIN); arch-only
// keying would silently conflate the two.
//
// The `.github/workflows/build-pg-runtime.yml` workflow (workflow_dispatch)
// builds all four platform/arch combinations, smoke-tests each tarball, and
// publishes them + a SHA256SUMS file to a `pg-runtime-17.5-1` GitHub release.
// After a real CI run of that workflow, paste the printed sha256 values into
// the placeholders below (see the workflow's "Print SHA256SUMS" step) and
// commit — the `TODO_PIN_*` guard below throws before any network fetch until
// every sha for a given platform/arch is pinned.
// ---------------------------------------------------------------------------

export const RUNTIME_MANIFEST = {
  version: "17.5-1", // pinned; bump when republishing runtime
  baseUrl: "https://github.com/AndreLYL/memkin/releases/download/pg-runtime-17.5-1",
  assets: {
    "darwin-arm64": {
      file: "memkin-pg-darwin-arm64.tar.gz",
      sha256: "ba21cb8e9f37e4b9808efba809fadfa5f0466478474a37ba420d1dc2af3de9da",
    },
    "darwin-x64": {
      file: "memkin-pg-darwin-x64.tar.gz",
      sha256: "58654b6658d29e1105ef63679df484d331c32c3e6fbd0b11b3eca0294cc6c4ca",
    },
    "linux-x64": {
      file: "memkin-pg-linux-x64.tar.gz",
      sha256: "b80a1ba87c9c4a56f462fda6c2647e73a5f4a486d988608e110bc0333a6a112d",
    },
    "linux-arm64": {
      file: "memkin-pg-linux-arm64.tar.gz",
      sha256: "b3c61aaccb9ad435b72dbaaad0bd4c97bfca935e5c5b08f0835ac33bc0f8abd7",
    },
  },
} as const;

/** Platform/arch combinations the managed runtime ships a prebuilt tarball for. */
export type SupportedAssetKey = keyof typeof RUNTIME_MANIFEST.assets;

/**
 * Minimum glibc the published linux tarballs require — the highest versioned
 * GLIBC_* symbol measured in the release binaries (postgres/psql/vector.so all
 * reference GLIBC_2.38, picked up from the ubuntu-24.04 build runner).
 * Update TOGETHER with the manifest shas when republishing the runtime:
 * building on ubuntu-22.04 lowers this to "2.35".
 */
export const LINUX_MIN_GLIBC = "2.38";

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);
const SUPPORTED_ARCHES: ReadonlySet<NodeJS.Architecture> = new Set(["arm64", "x64"]);

/**
 * Resolve the manifest asset key for a given platform+arch, or `undefined`
 * if unsupported. Exported for tests.
 */
export function resolveAssetKey(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): SupportedAssetKey | undefined {
  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHES.has(arch)) return undefined;
  const key = `${platform}-${arch}`;
  return key in RUNTIME_MANIFEST.assets ? (key as SupportedAssetKey) : undefined;
}

// ---------------------------------------------------------------------------
// Injectable download deps (for testing without network/tar)
// ---------------------------------------------------------------------------

export interface ProviderDownloadDeps {
  /** Override manifest (for tests that need a pinned sha). Defaults to RUNTIME_MANIFEST. */
  manifest?: typeof RUNTIME_MANIFEST;
  /** Fetch a tarball at the given URL and return its bytes. Defaults to a real fetch. */
  fetchTarball?: (url: string) => Promise<Buffer>;
  /** Extract a tar.gz file at tarPath into destDir. Defaults to spawning `tar -xzf`. */
  extract?: (tarPath: string, destDir: string) => Promise<void>;
  /** Process architecture — defaults to process.arch. */
  arch?: NodeJS.Architecture;
  /** Process platform — defaults to process.platform. */
  platform?: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const REQUIRED_BINARIES = ["postgres", "pg_ctl", "initdb", "createdb", "pg_isready"] as const;
const VECTOR_LIBS = ["vector.dylib", "vector.so"] as const;
const REQUIRED_EXTENSIONS = ["pg_trgm.control", "vector.control"] as const;

function buildRuntimePaths(root: string, pgMajor: string): RuntimePaths {
  const bin = join(root, "bin");
  return {
    root,
    pgMajor,
    bin,
    postgres: join(bin, "postgres"),
    pgCtl: join(bin, "pg_ctl"),
    initdb: join(bin, "initdb"),
    createdb: join(bin, "createdb"),
    pgIsReady: join(bin, "pg_isready"),
    libDir: join(root, "lib", "postgresql"),
    extensionDir: join(root, "share", "postgresql", "extension"),
  };
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validateRuntime(root: string, pgMajor: string): RuntimePaths {
  const paths = buildRuntimePaths(root, pgMajor);

  // Check each required binary exists and is executable
  for (const bin of REQUIRED_BINARIES) {
    const p = join(paths.bin, bin);
    if (!existsSync(p)) {
      throw new Error(
        `managed Postgres runtime validation failed: missing binary '${bin}' in ${paths.bin} (runtime root: ${root})`,
      );
    }
    if (!isExecutable(p)) {
      throw new Error(
        `managed Postgres runtime validation failed: '${bin}' is not executable in ${paths.bin} (runtime root: ${root})`,
      );
    }
  }

  // Check at least one of vector.dylib / vector.so exists
  const hasVectorLib = VECTOR_LIBS.some((lib) => existsSync(join(paths.libDir, lib)));
  if (!hasVectorLib) {
    throw new Error(
      `managed Postgres runtime validation failed: missing pgvector shared library (vector.dylib or vector.so) in ${paths.libDir} (runtime root: ${root})`,
    );
  }

  // Check required extension control files
  for (const ext of REQUIRED_EXTENSIONS) {
    const p = join(paths.extensionDir, ext);
    if (!existsSync(p)) {
      throw new Error(
        `managed Postgres runtime validation failed: missing extension '${ext}' in ${paths.extensionDir} (runtime root: ${root})`,
      );
    }
  }

  return paths;
}

/**
 * Recursively walk `dir` and throw if any symlink resolves outside `root`.
 * This guards against path-traversal attacks in a downloaded tarball.
 */
function assertNoPathTraversal(root: string, dir: string): void {
  const realRoot = realpathSync(root);

  function walk(current: string): void {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        // Resolve the symlink target to an absolute path
        let resolved: string;
        try {
          resolved = realpathSync(entryPath);
        } catch {
          // Dangling symlink — reject
          throw new Error(
            `path-traversal guard: dangling symlink at ${entryPath} in extracted runtime`,
          );
        }
        if (!resolved.startsWith(`${realRoot}/`) && resolved !== realRoot) {
          throw new Error(
            `path-traversal guard: symlink ${entryPath} points outside extraction dir (resolved to ${resolved})`,
          );
        }
        // Don't recurse into symlinks — they've been validated above
      } else if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(dir);
}

/**
 * Default fetchTarball: real HTTP fetch returning a Buffer.
 */
async function defaultFetchTarball(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `failed to fetch runtime tarball from ${url}: ${resp.status} ${resp.statusText}`,
    );
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Default extract: spawn `tar -xzf` with safe flags.
 */
async function defaultExtract(tarPath: string, destDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    // --no-same-owner prevents ownership attacks; -C changes into destDir
    const proc = spawn("tar", ["-xzf", tarPath, "-C", destDir, "--no-same-owner"], {
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPgRuntimeProvider(
  opts: ProviderOptions,
  deps: ProviderDownloadDeps = {},
): PgRuntimeProvider {
  const {
    manifest = RUNTIME_MANIFEST,
    fetchTarball = defaultFetchTarball,
    extract = defaultExtract,
    arch = process.arch as NodeJS.Architecture,
    platform = process.platform,
  } = deps;

  /** Resolve override dir (explicit runtimeDir > env var > already-present runtimeRoot). */
  function resolveOverrideDir(): string | undefined {
    const { home, pgMajor, runtimeDir } = opts;
    const envOverride = process.env.MEMKIN_PG_RUNTIME_DIR;
    const paths = managedPaths(home, pgMajor);

    if (runtimeDir !== undefined) return runtimeDir;
    if (envOverride !== undefined) return envOverride;
    if (existsSync(paths.runtimeRoot)) return paths.runtimeRoot;
    return undefined;
  }

  return {
    /**
     * verify() — checks an ALREADY-present runtime without downloading.
     * Used by `memkin doctor` so it never triggers a 40-80 MB download as a side effect.
     */
    async verify(): Promise<RuntimePaths> {
      const { home, pgMajor } = opts;
      const overrideDir = resolveOverrideDir();

      if (overrideDir !== undefined) {
        return validateRuntime(overrideDir, pgMajor);
      }

      const paths = managedPaths(home, pgMajor);
      throw new Error(
        `managed Postgres runtime not provisioned at ${paths.runtimeRoot} — run \`memkin up\``,
      );
    },

    /**
     * ensure() — validates existing runtime OR downloads it on first-run.
     * Used by `memkin up`.
     */
    async ensure(): Promise<RuntimePaths> {
      const { home, pgMajor } = opts;
      const overrideDir = resolveOverrideDir();

      if (overrideDir !== undefined) {
        return validateRuntime(overrideDir, pgMajor);
      }

      // -----------------------------------------------------------------------
      // Download path — no runtime present yet
      // -----------------------------------------------------------------------

      // 1. Pick asset by platform+arch (NOT arch alone — see RUNTIME_MANIFEST comment).
      const assetKey = resolveAssetKey(platform, arch);
      if (assetKey === undefined) {
        throw new Error(
          `The self-managed Postgres engine currently supports macOS and Linux only ` +
            `(darwin/linux, arm64/x64); your platform (${platform}/${arch}) is not supported yet. ` +
            `Use the default PGLite backend instead — it works everywhere. ` +
            `Set \`store.engine: pglite\` in memkin.yaml (or remove \`store.engine\` to use the default).`,
        );
      }

      const asset = manifest.assets[assetKey];

      // 2. Guard against unpinned manifest shas before hitting the network
      if (asset.sha256.startsWith("TODO_PIN_")) {
        throw new Error(
          `managed Postgres runtime checksum not pinned — build/publish the runtime first (manifest.assets.${assetKey}.sha256 is still a placeholder)`,
        );
      }

      // 3. Fetch
      const url = `${manifest.baseUrl}/${asset.file}`;
      const buf = await fetchTarball(url);

      // 4. Verify sha256
      const actual = createHash("sha256").update(buf).digest("hex");
      if (actual !== asset.sha256) {
        throw new Error(
          `managed Postgres runtime checksum mismatch for ${asset.file}:\n  expected: ${asset.sha256}\n  actual:   ${actual}\n(re-run with a fresh download or update the manifest)`,
        );
      }

      // 5. Write buf to a temp file under the same filesystem (.memkin/tmp) to
      //    keep the later atomic rename cross-device-safe.
      const managedBase = managedPaths(home, pgMajor).base;
      mkdirSync(managedBase, { recursive: true });

      const tmpBase = join(managedBase, "tmp");
      mkdirSync(tmpBase, { recursive: true });

      const tarPath = join(tmpBase, asset.file);
      writeFileSync(tarPath, buf);

      // 6. mkdtemp extract dir under the same base
      const tmpExtract = mkdtempSync(join(tmpBase, "extract-"));

      try {
        await extract(tarPath, tmpExtract);

        // 7. Path-traversal / symlink guard
        assertNoPathTraversal(tmpExtract, tmpExtract);

        // 8. Validate the extracted structure
        validateRuntime(tmpExtract, pgMajor);

        // 9. Atomic move into place
        const { runtimeRoot } = managedPaths(home, pgMajor);
        mkdirSync(join(runtimeRoot, ".."), { recursive: true });
        renameSync(tmpExtract, runtimeRoot);

        // 10. Write manifest record
        writeFileSync(
          join(runtimeRoot, "manifest.json"),
          JSON.stringify(
            { version: manifest.version, sha256: asset.sha256, platformArch: assetKey },
            null,
            2,
          ),
          "utf8",
        );

        return validateRuntime(runtimeRoot, pgMajor);
      } finally {
        // Clean up tmp tarball (the extract dir is either moved or already gone)
        try {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(tarPath);
        } catch {
          // best-effort
        }
      }
    },
  };
}
