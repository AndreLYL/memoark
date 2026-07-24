import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureStateDir, stateDirFor, statePath } from "../../src/core/state.js";

describe("state dir resolution (home-install .memkin base)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `memkin-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("appends .memkin for a project-level base", () => {
    expect(stateDirFor(testDir)).toBe(resolve(testDir, ".memkin"));
  });

  it("uses a base that already IS .memkin as-is (no ~/.memkin/.memkin nesting)", () => {
    const home = join(testDir, ".memkin"); // home install: config at ~/.memkin/memkin.yaml
    mkdirSync(home, { recursive: true });
    expect(stateDirFor(home)).toBe(home);
    expect(ensureStateDir(home)).toBe(home);
    expect(statePath("scheduler-state.json", home)).toBe(join(home, "scheduler-state.json"));
  });

  it("keeps statePath and ensureStateDir aligned for a .memkin base", () => {
    const home = join(testDir, ".memkin");
    const stateDir = ensureStateDir(home);
    expect(statePath("cursors.yaml", home)).toBe(join(stateDir, "cursors.yaml"));
  });

  describe("nested-state migration (pre-fix ~/.memkin/.memkin layout)", () => {
    it("moves files from the nested dir up and removes it", () => {
      const home = join(testDir, ".memkin");
      const nested = join(home, ".memkin");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "scheduler-state.json"), '{"sources":{}}');
      writeFileSync(join(nested, "cursors.yaml"), "a: 1\n");

      const stateDir = ensureStateDir(home);

      expect(stateDir).toBe(home);
      expect(readFileSync(join(home, "scheduler-state.json"), "utf-8")).toBe('{"sources":{}}');
      expect(readFileSync(join(home, "cursors.yaml"), "utf-8")).toBe("a: 1\n");
      expect(existsSync(nested)).toBe(false);
    });

    it("never overwrites a file already at the right place", () => {
      const home = join(testDir, ".memkin");
      const nested = join(home, ".memkin");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(home, "cursors.yaml"), "current: true\n");
      writeFileSync(join(nested, "cursors.yaml"), "stale: true\n");

      ensureStateDir(home);

      expect(readFileSync(join(home, "cursors.yaml"), "utf-8")).toBe("current: true\n");
      // The stale copy stays behind (nested dir kept because it is not empty).
      expect(readFileSync(join(nested, "cursors.yaml"), "utf-8")).toBe("stale: true\n");
    });

    it("does not migrate for a project-level base (no .memkin-in-.memkin ever existed)", () => {
      const stateDir = ensureStateDir(testDir);
      expect(stateDir).toBe(resolve(testDir, ".memkin"));
      expect(existsSync(join(stateDir, ".memkin"))).toBe(false);
    });
  });
});
