/**
 * State directory management for DigitalBrainExtractor
 * Ensures .memkin/ directory exists and provides path utilities
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * Resolve the state directory for a base directory WITHOUT creating it.
 *
 * A base that already IS a `.memkin` directory is used as-is: the home install
 * puts the config at `~/.memkin/memkin.yaml`, so projectRoot is `~/.memkin` and
 * appending unconditionally nested all state one level too deep at
 * `~/.memkin/.memkin/` — split from daemon.json/install-state.json beside it.
 * Project-level configs (`myproj/memkin.yaml`) keep the `myproj/.memkin/`
 * convention unchanged.
 */
export function stateDirFor(base?: string): string {
  const baseDir = resolve(base || process.cwd());
  return basename(baseDir) === ".memkin" ? baseDir : resolve(baseDir, ".memkin");
}

/**
 * Ensure state directory exists (creates .memkin/ in base directory)
 * Uses mkdir -p equivalent to create all intermediate directories
 *
 * @param base - Base directory path (default: current working directory)
 * @returns Full path to the state directory
 */
export function ensureStateDir(base?: string): string {
  const stateDir = stateDirFor(base);
  mkdirSync(stateDir, { recursive: true });
  migrateNestedStateDir(stateDir);
  return stateDir;
}

/**
 * Get full path for a state file
 * Returns .memkin/{filename} path without creating directories
 * Call ensureStateDir() first to ensure the directory exists
 *
 * @param filename - Name of the state file (e.g., 'cursors.yaml', 'checkpoints.jsonl')
 * @returns Full path to the state file
 */
export function statePath(filename: string, base?: string): string {
  return resolve(stateDirFor(base), filename);
}

/**
 * Heal the pre-fix layout: ensureStateDir used to append `.memkin` even when
 * the base already was `~/.memkin`, so daemons wrote scheduler/cursor state to
 * `~/.memkin/.memkin/`. Move those files up (never overwriting a newer file at
 * the right place) so existing installs keep their scheduler backoff and
 * dedup/cursor checkpoints instead of silently re-extracting from scratch.
 */
function migrateNestedStateDir(stateDir: string): void {
  if (basename(stateDir) !== ".memkin") return;
  const nested = resolve(stateDir, ".memkin");
  let entries: string[];
  try {
    if (!statSync(nested).isDirectory()) return;
    entries = readdirSync(nested);
  } catch {
    return; // no nested dir — nothing to heal
  }
  for (const name of entries) {
    const to = resolve(stateDir, name);
    try {
      // rename() replaces an existing destination — check first so a file
      // already at the right place (the actively-used one) is never clobbered.
      if (!existsSync(to)) renameSync(resolve(nested, name), to);
    } catch {
      // Best-effort: leave the stray file behind rather than fail startup.
    }
  }
  try {
    rmdirSync(nested); // only succeeds once empty
  } catch {
    // Leftovers from a partial move — harmless.
  }
}
