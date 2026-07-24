import { describe, expect, it } from "vitest";
import { checkManagedHostSupport, detectGlibcVersion, glibcAtLeast } from "./host-support.js";

describe("glibcAtLeast", () => {
  it("compares major.minor numerically, not lexically", () => {
    expect(glibcAtLeast("2.39", "2.38")).toBe(true);
    expect(glibcAtLeast("2.38", "2.38")).toBe(true);
    expect(glibcAtLeast("2.35", "2.38")).toBe(false);
    expect(glibcAtLeast("3.0", "2.38")).toBe(true);
    expect(glibcAtLeast("2.4", "2.38")).toBe(false); // 4 < 38, not "2.4" > "2.38"
  });

  it("treats malformed versions as not-at-least (conservative)", () => {
    expect(glibcAtLeast("musl", "2.38")).toBe(false);
    expect(glibcAtLeast("", "2.38")).toBe(false);
  });
});

describe("checkManagedHostSupport", () => {
  const notRoot = () => 1000;
  const glibcOk = () => "2.39";

  it("ok on supported platform/arch, non-root, new glibc", () => {
    expect(
      checkManagedHostSupport({
        platform: "linux",
        arch: "x64",
        getuid: notRoot,
        glibcVersion: glibcOk,
      }),
    ).toEqual({ level: "ok" });
  });

  it("hard-no on unsupported platform/arch", () => {
    const r = checkManagedHostSupport({
      platform: "win32",
      arch: "x64",
      getuid: notRoot,
      glibcVersion: glibcOk,
    });
    expect(r.level).toBe("hard-no");
    expect(r.reason).toMatch(/win32\/x64/);
  });

  it("hard-no when running as root, with actionable guidance", () => {
    const r = checkManagedHostSupport({
      platform: "linux",
      arch: "x64",
      getuid: () => 0,
      glibcVersion: glibcOk,
    });
    expect(r.level).toBe("hard-no");
    expect(r.reason).toMatch(/root/);
    expect(r.reason).toMatch(/store\.engine: pglite/);
  });

  it("hard-no on linux when glibc is below the baseline, naming both versions", () => {
    const r = checkManagedHostSupport({
      platform: "linux",
      arch: "x64",
      getuid: notRoot,
      glibcVersion: () => "2.35",
    });
    expect(r.level).toBe("hard-no");
    expect(r.reason).toMatch(/2\.35/);
    expect(r.reason).toMatch(/2\.38/);
  });

  it("soft-no on linux when glibc cannot be determined", () => {
    const r = checkManagedHostSupport({
      platform: "linux",
      arch: "x64",
      getuid: notRoot,
      glibcVersion: () => undefined,
    });
    expect(r.level).toBe("soft-no");
  });

  it("skips the glibc check on darwin", () => {
    expect(
      checkManagedHostSupport({
        platform: "darwin",
        arch: "arm64",
        getuid: () => 501,
        glibcVersion: () => undefined,
      }),
    ).toEqual({ level: "ok" });
  });

  it("getuid undefined (win32-style) is not treated as root", () => {
    // Platform gate fires first for win32; use a supported platform to isolate the uid rule.
    expect(
      checkManagedHostSupport({
        platform: "linux",
        arch: "x64",
        getuid: () => undefined,
        glibcVersion: glibcOk,
      }),
    ).toEqual({ level: "ok" });
  });
});

describe("detectGlibcVersion", () => {
  it("returns a plausible version string or undefined, without throwing", () => {
    const v = detectGlibcVersion();
    if (v !== undefined) {
      expect(v).toMatch(/^\d+\.\d+$/);
    }
  });
});
