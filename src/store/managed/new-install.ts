import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkManagedHostSupport } from "./host-support.js";

/** True if ~/.memkin/data exists and is a non-empty PGLite data dir. */
export function hasExistingPgliteData(home: string): boolean {
  const dir = join(home, ".memkin", "data");
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Decide the default engine for a NEW install (no config yet).
 * managed (zero-config real Postgres) when the host verifiably supports the
 * prebuilt runtime — supported platform/arch (see RUNTIME_MANIFEST), not
 * running as root, glibc at least the runtime's baseline on linux — and there
 * is no existing PGLite data. Anything else (unsupported platform, root,
 * old/undeterminable glibc, existing data) falls back to pglite: the safe
 * default that never breaks an install and never silently abandons data.
 */
export function resolveDefaultEngineForNewInstall(opts: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  home: string;
  /** Override uid lookup (tests). Default: process.getuid. */
  getuid?: () => number | undefined;
  /** Override glibc detection (tests). Default: real detection. */
  glibcVersion?: () => string | undefined;
}): "managed" | "pglite" {
  const support = checkManagedHostSupport({
    platform: opts.platform,
    arch: opts.arch,
    getuid: opts.getuid,
    glibcVersion: opts.glibcVersion,
  });
  if (support.level === "ok" && !hasExistingPgliteData(opts.home)) return "managed";
  return "pglite";
}
