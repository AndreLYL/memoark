import { spawnSync } from "node:child_process";
import { LINUX_MIN_GLIBC, resolveAssetKey } from "./pg-runtime-provider.js";

/**
 * Host preflight for the managed Postgres engine.
 *
 * - "ok"      → this host can run the prebuilt runtime.
 * - "hard-no" → it provably cannot (unsupported platform/arch, running as
 *               root, glibc older than the runtime's baseline). Used both to
 *               fall back to pglite on new installs and to fail provision
 *               early with an actionable message instead of a raw initdb /
 *               loader error.
 * - "soft-no" → could not verify (glibc undeterminable, e.g. musl or an
 *               exotic runtime). New-install defaulting treats this as "no"
 *               (never break an install on a guess); an explicitly configured
 *               managed engine proceeds (never block on mere uncertainty).
 */
export type HostSupportLevel = "ok" | "soft-no" | "hard-no";

export interface HostSupport {
  level: HostSupportLevel;
  reason?: string;
}

export interface HostSupportOpts {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  /** Override uid lookup (tests). Default: process.getuid (undefined on win32). */
  getuid?: () => number | undefined;
  /** Override glibc detection (tests). Default: detectGlibcVersion. */
  glibcVersion?: () => string | undefined;
}

/**
 * Detect the glibc version this process is running against, or undefined when
 * it cannot be determined (musl libc, runtimes without process.report, no
 * getconf on PATH). process.report is the cheap in-process source on Node;
 * `getconf GNU_LIBC_VERSION` covers runtimes that don't populate it.
 */
export function detectGlibcVersion(): string | undefined {
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const v = report?.header?.glibcVersionRuntime;
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
    // fall through to getconf
  }
  try {
    const out = spawnSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8", timeout: 3000 });
    if (out.status === 0) {
      const m = out.stdout.match(/(\d+\.\d+)/);
      if (m) return m[1];
    }
  } catch {
    // undeterminable
  }
  return undefined;
}

/** True when `version` ("2.39") is at least `minimum` ("2.38"); malformed input → false. */
export function glibcAtLeast(version: string, minimum: string): boolean {
  const parse = (s: string): [number, number] => {
    const [major, minor] = s.split(".");
    return [Number.parseInt(major, 10), Number.parseInt(minor ?? "0", 10)];
  };
  const [vMajor, vMinor] = parse(version);
  const [mMajor, mMinor] = parse(minimum);
  if (!Number.isFinite(vMajor) || !Number.isFinite(vMinor)) return false;
  if (vMajor !== mMajor) return vMajor > mMajor;
  return vMinor >= mMinor;
}

export function checkManagedHostSupport(opts: HostSupportOpts): HostSupport {
  const getuid = opts.getuid ?? (() => process.getuid?.());
  const glibcVersion = opts.glibcVersion ?? detectGlibcVersion;

  if (resolveAssetKey(opts.platform, opts.arch) === undefined) {
    return {
      level: "hard-no",
      reason:
        `the managed Postgres runtime has no prebuilt binaries for ${opts.platform}/${opts.arch} ` +
        `(supported: darwin/linux on arm64/x64). Use \`store.engine: pglite\` instead.`,
    };
  }

  if (getuid() === 0) {
    return {
      level: "hard-no",
      reason:
        "managed Postgres cannot run as root — PostgreSQL's initdb/postgres refuse to start " +
        "under uid 0. Install and run memkin as a regular user (e.g. `useradd -m memkin && " +
        "su - memkin`), or set `store.engine: pglite` in memkin.yaml.",
    };
  }

  if (opts.platform === "linux") {
    const v = glibcVersion();
    if (v === undefined) {
      return {
        level: "soft-no",
        reason:
          "could not determine this machine's glibc version (musl-based distros like Alpine " +
          "are not supported by the prebuilt Postgres runtime).",
      };
    }
    if (!glibcAtLeast(v, LINUX_MIN_GLIBC)) {
      return {
        level: "hard-no",
        reason:
          `this machine's glibc ${v} is older than the ${LINUX_MIN_GLIBC} required by the ` +
          `prebuilt Postgres runtime. Upgrade the OS (e.g. Ubuntu 24.04+ / Debian 13+), or ` +
          `set \`store.engine: pglite\` in memkin.yaml.`,
      };
    }
  }

  return { level: "ok" };
}
