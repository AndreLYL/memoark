import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasExistingPgliteData, resolveDefaultEngineForNewInstall } from "./new-install.js";

describe("hasExistingPgliteData", () => {
  it("returns false when ~/.memkin/data does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    expect(hasExistingPgliteData(home)).toBe(false);
  });

  it("returns false when ~/.memkin/data exists but is empty", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    mkdirSync(join(home, ".memkin", "data"), { recursive: true });
    expect(hasExistingPgliteData(home)).toBe(false);
  });

  it("returns true when ~/.memkin/data exists and has files", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    const dataDir = join(home, ".memkin", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "base.tar.gz"), "fake-pglite-data");
    expect(hasExistingPgliteData(home)).toBe(true);
  });
});

describe("resolveDefaultEngineForNewInstall", () => {
  // Deterministic host: not root, glibc new enough. The real defaults depend on
  // the machine running the tests (containers are often root), so every case
  // injects them; the detection itself is covered in host-support.test.ts.
  const okHost = { getuid: () => 1000, glibcVersion: () => "2.39" };

  it("returns 'managed' on darwin with no existing PGLite data", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    expect(
      resolveDefaultEngineForNewInstall({ platform: "darwin", arch: "arm64", home, ...okHost }),
    ).toBe("managed");
    expect(
      resolveDefaultEngineForNewInstall({ platform: "darwin", arch: "x64", home, ...okHost }),
    ).toBe("managed");
  });

  it("returns 'managed' on linux with no existing PGLite data (runtime tarballs ship for linux)", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    expect(
      resolveDefaultEngineForNewInstall({ platform: "linux", arch: "x64", home, ...okHost }),
    ).toBe("managed");
    expect(
      resolveDefaultEngineForNewInstall({ platform: "linux", arch: "arm64", home, ...okHost }),
    ).toBe("managed");
  });

  it("returns 'pglite' when existing PGLite data is present (P1-5 guard), on every platform", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    const dataDir = join(home, ".memkin", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "base.tar.gz"), "fake-pglite-data");
    expect(
      resolveDefaultEngineForNewInstall({ platform: "darwin", arch: "arm64", home, ...okHost }),
    ).toBe("pglite");
    expect(
      resolveDefaultEngineForNewInstall({ platform: "linux", arch: "x64", home, ...okHost }),
    ).toBe("pglite");
  });

  it("returns 'pglite' on platforms without a managed runtime tarball", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    expect(
      resolveDefaultEngineForNewInstall({ platform: "win32", arch: "x64", home, ...okHost }),
    ).toBe("pglite");
    expect(
      resolveDefaultEngineForNewInstall({ platform: "linux", arch: "ia32", home, ...okHost }),
    ).toBe("pglite");
  });

  it("returns 'pglite' when running as root (initdb refuses uid 0)", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    const asRoot = { getuid: () => 0, glibcVersion: () => "2.39" };
    expect(
      resolveDefaultEngineForNewInstall({ platform: "linux", arch: "x64", home, ...asRoot }),
    ).toBe("pglite");
    expect(
      resolveDefaultEngineForNewInstall({ platform: "darwin", arch: "arm64", home, ...asRoot }),
    ).toBe("pglite");
  });

  it("returns 'pglite' on linux when glibc is older than the runtime baseline", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    expect(
      resolveDefaultEngineForNewInstall({
        platform: "linux",
        arch: "x64",
        home,
        getuid: () => 1000,
        glibcVersion: () => "2.35",
      }),
    ).toBe("pglite");
  });

  it("returns 'pglite' on linux when glibc cannot be determined (e.g. musl)", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    expect(
      resolveDefaultEngineForNewInstall({
        platform: "linux",
        arch: "x64",
        home,
        getuid: () => 1000,
        glibcVersion: () => undefined,
      }),
    ).toBe("pglite");
  });

  it("ignores glibc on darwin (undeterminable there is still 'managed')", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-test-"));
    expect(
      resolveDefaultEngineForNewInstall({
        platform: "darwin",
        arch: "arm64",
        home,
        getuid: () => 501,
        glibcVersion: () => undefined,
      }),
    ).toBe("managed");
  });
});
