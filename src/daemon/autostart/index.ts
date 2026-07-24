import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonState } from "./daemon-state.js";
import { readDaemonState, writeDaemonState } from "./daemon-state.js";
import { launchdBootout, launchdLoad, launchdStatus, renderLaunchdPlist } from "./launchd.js";
import type { CommandRunner } from "./runner.js";
import { renderSystemdUnit, systemdDisable, systemdStatus } from "./systemd.js";

const LABEL = "com.memkin.daemon";

function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", "com.memkin.daemon.plist");
}

function systemdUnitPath(home: string): string {
  return join(home, ".config", "systemd", "user", "memkin.service");
}

function stateDir(home: string): string {
  return join(home, ".memkin");
}

export interface EnableAutostartOptions {
  platform: string;
  home: string;
  runner: CommandRunner;
  state: DaemonState;
  env: Record<string, string>;
  /** Linux only: run `loginctl enable-linger` so the service survives logout. */
  linger?: boolean;
}

export interface DisableAutostartOptions {
  platform: string;
  home: string;
  runner: CommandRunner;
  /**
   * When true, do NOT remove plist/daemon.json if outcome is "bootoutFailed".
   * This preserves daemon state for a still-alive daemon.
   * Default: false (existing behavior — always remove files).
   */
  keepStateOnBootoutFailure?: boolean;
}

export interface StatusAutostartOptions {
  platform: string;
  home: string;
  runner: CommandRunner;
}

export interface AutostartStatus {
  desired: DaemonState | null;
  raw: string;
}

export async function enableAutostart(opts: EnableAutostartOptions): Promise<void> {
  const { platform, home, runner, state, env, linger } = opts;

  if (platform === "darwin") {
    const logsDir = join(home, ".memkin", "logs");
    const plist = renderLaunchdPlist({
      label: LABEL,
      argv: state.argv,
      stdoutPath: join(logsDir, "daemon.out.log"),
      stderrPath: join(logsDir, "daemon.err.log"),
      env,
    });

    const laDir = join(home, "Library", "LaunchAgents");
    mkdirSync(laDir, { recursive: true });
    writeFileSync(plistPath(home), plist, { encoding: "utf8", mode: 0o600 });
    chmodSync(plistPath(home), 0o600);

    const sd = stateDir(home);
    mkdirSync(sd, { recursive: true });
    writeDaemonState(sd, state);

    const uid = process.getuid?.() ?? 0;
    const result = await launchdLoad(runner, plistPath(home), uid);
    if (result.code !== 0) {
      rmSync(plistPath(home), { force: true });
      rmSync(join(sd, "daemon.json"), { force: true });
      throw new Error(
        `launchctl bootstrap failed (exit ${result.code}): ${result.stderr || result.stdout}`,
      );
    }
  } else if (platform === "linux") {
    const unit = renderSystemdUnit({
      description: "Memkin Daemon",
      argv: state.argv,
      env,
    });

    const unitDir = join(home, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(systemdUnitPath(home), unit, { encoding: "utf8", mode: 0o600 });
    chmodSync(systemdUnitPath(home), 0o600);

    const sd = stateDir(home);
    mkdirSync(sd, { recursive: true });
    writeDaemonState(sd, state);

    // Environments without a systemd user instance (Docker containers, some CI)
    // can't host the autostart service at all — point at the foreground mode
    // instead of leaving a bare systemctl error.
    const noSystemdHint =
      " If this environment has no systemd (e.g. a container), skip `memkin up` and run the " +
      "daemon in the foreground instead: `memkin serve --mcp-http`.";
    const reloadResult = await runner.run(["systemctl", "--user", "daemon-reload"]);
    if (reloadResult.code !== 0) {
      rmSync(systemdUnitPath(home), { force: true });
      rmSync(join(sd, "daemon.json"), { force: true });
      throw new Error(
        `systemctl daemon-reload failed (exit ${reloadResult.code}): ${reloadResult.stderr || reloadResult.stdout}.${noSystemdHint}`,
      );
    }
    const enableResult = await runner.run([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "memkin.service",
    ]);
    if (enableResult.code !== 0) {
      rmSync(systemdUnitPath(home), { force: true });
      rmSync(join(sd, "daemon.json"), { force: true });
      throw new Error(
        `systemctl enable failed (exit ${enableResult.code}): ${enableResult.stderr || enableResult.stdout}.${noSystemdHint}`,
      );
    }
    // FIX 4: wire --linger so the service survives user logout
    if (linger) {
      const user = process.env.USER ?? process.env.LOGNAME ?? String(process.getuid?.() ?? "");
      await runner.run(["loginctl", "enable-linger", user]);
      // best-effort: if loginctl fails, we still succeed (linger is advisory)
    }
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

export interface DisableAutostartResult {
  outcome: "notLoaded" | "bootoutFailed" | "success";
  launcherStderr?: string;
  launcherCode?: number;
}

/** Regex for "no such process / not loaded" patterns from launchctl/systemctl. */
const NOT_LOADED_RE = /no such process|could not find|not.*loaded/i;

function classifyBootoutResult(
  code: number,
  stderr: string,
): "notLoaded" | "bootoutFailed" | "success" {
  if (code === 0) return "success";
  if (NOT_LOADED_RE.test(stderr)) return "notLoaded";
  return "bootoutFailed";
}

export async function disableAutostart(
  opts: DisableAutostartOptions,
): Promise<DisableAutostartResult> {
  const { platform, home, runner, keepStateOnBootoutFailure = false } = opts;

  if (platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const result = await launchdBootout(runner, LABEL, uid);
    const stderr = result.stderr || result.stdout;
    const outcome = classifyBootoutResult(result.code, stderr);

    // Remove files unless keepStateOnBootoutFailure is true AND the outcome is bootoutFailed
    const preserve = keepStateOnBootoutFailure && outcome === "bootoutFailed";
    if (!preserve) {
      rmSync(plistPath(home), { force: true });
      rmSync(join(stateDir(home), "daemon.json"), { force: true });
    }

    if (result.code !== 0) {
      return { outcome, launcherCode: result.code, launcherStderr: stderr };
    }
    return { outcome };
  } else if (platform === "linux") {
    const result = await systemdDisable(runner);
    const stderr = result.stderr || result.stdout;
    // For Linux: treat not-loaded patterns as notLoaded; else bootoutFailed on non-zero
    const outcome = classifyBootoutResult(result.code, stderr);

    const preserve = keepStateOnBootoutFailure && outcome === "bootoutFailed";
    if (!preserve) {
      rmSync(systemdUnitPath(home), { force: true });
      rmSync(join(stateDir(home), "daemon.json"), { force: true });
    }

    if (result.code !== 0) {
      return { outcome, launcherCode: result.code, launcherStderr: stderr };
    }
    return { outcome };
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

export async function statusAutostart(opts: StatusAutostartOptions): Promise<AutostartStatus> {
  const { platform, home, runner } = opts;

  const desired = readDaemonState(stateDir(home));
  const uid = process.getuid?.() ?? 0;

  let result: import("./runner.js").CommandResult;
  if (platform === "darwin") {
    result = await launchdStatus(runner, LABEL, uid);
  } else if (platform === "linux") {
    result = await systemdStatus(runner);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return { desired, raw: result.stdout };
}
