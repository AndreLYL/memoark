import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigPath, isFirstRun, runInit, shouldUseTui } from "../../src/setup/init-wizard.js";

const OPENAI_API_KEY_PLACEHOLDER = "$" + "{OPENAI_API_KEY}";

class MemoryWritable extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("init wizard", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalOpenAI: string | undefined;
  let originalAnthropic: string | undefined;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "memkin-init-"));
    originalCwd = process.cwd();
    originalOpenAI = process.env.OPENAI_API_KEY;
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // Point HOME at an empty temp dir so detectApiKeys()'s shell-file fallback
    // (.zshrc/.bashrc/...) can't leak a real developer's API key into the test.
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalOpenAI === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAI;
    }
    if (originalAnthropic === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves config paths and first-run state", () => {
    expect(getConfigPath()).toBe(resolve(process.cwd(), "memkin.yaml"));
    expect(isFirstRun()).toBe(true);
  });

  it("writes config in automatic mode", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const output = new MemoryWritable();

    await runInit({ auto: true, output });

    expect(existsSync("memkin.yaml")).toBe(true);
    const yaml = readFileSync("memkin.yaml", "utf-8");
    expect(yaml).toContain(`api_key: ${OPENAI_API_KEY_PLACEHOLDER}`);
    expect(yaml).toContain("claude-code:");
    // Fresh installs enable auto-fetch (web-wizard parity) so `serve` schedules
    // the enabled channels without any manual scheduler config.
    expect(yaml).toMatch(/scheduler:\n {2}enabled: true/);
    expect(output.text()).toContain("[ok] Configuration saved");
  });

  it("fails automatic mode without an API key", async () => {
    await expect(runInit({ auto: true, output: new MemoryWritable() })).rejects.toThrow(
      "No API key found",
    );
  });

  it("runs the interactive flow with injected input", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    }) as unknown as typeof fetch;
    const input = Readable.from(["\n", "\n", "\n", "\n", "\n", "\n", "\n"]);
    const output = new MemoryWritable();

    try {
      await runInit({ input, output, registerCommand: false });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const yaml = readFileSync("memkin.yaml", "utf-8");
    expect(yaml).toContain("provider: openai");
    expect(yaml).toContain("model: gpt-4o-mini");
    expect(yaml).toContain(`api_key: ${OPENAI_API_KEY_PLACEHOLDER}`);
    expect(yaml).toMatch(/scheduler:\n {2}enabled: true/);
    expect(output.text()).toContain("Welcome to Memkin Setup");
  });

  it("selects TUI only for TTY interactive init", () => {
    const ttyInput = { isTTY: true } as NodeJS.ReadStream;
    const ttyOutput = { isTTY: true } as NodeJS.WriteStream;
    const pipeInput = { isTTY: false } as NodeJS.ReadStream;
    const pipeOutput = { isTTY: false } as NodeJS.WriteStream;

    expect(shouldUseTui({ auto: true }, ttyInput, ttyOutput, {})).toBe(false);
    expect(shouldUseTui({ tui: false }, ttyInput, ttyOutput, {})).toBe(false);
    expect(shouldUseTui({}, ttyInput, ttyOutput, { MEMKIN_NO_TUI: "1" })).toBe(false);
    expect(shouldUseTui({}, ttyInput, ttyOutput, { MEMKIN_NO_TUI: "true" })).toBe(false);
    expect(shouldUseTui({}, ttyInput, ttyOutput, { MEMKIN_NO_TUI: "yes" })).toBe(false);
    expect(shouldUseTui({}, pipeInput, ttyOutput, {})).toBe(false);
    expect(shouldUseTui({}, ttyInput, pipeOutput, {})).toBe(false);
    expect(shouldUseTui({}, ttyInput, ttyOutput, {})).toBe(true);
  });
});
