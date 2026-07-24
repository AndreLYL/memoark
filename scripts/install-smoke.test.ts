import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function minimalPathWithNodeAndNpm(): string {
  const nodePath = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
  const npmPath = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "memkin-bin-"));
  symlinkSync(nodePath, join(bin, "node"));
  symlinkSync(npmPath, join(bin, "npm"));
  return `${bin}:/usr/bin:/bin`;
}

describe("install.sh orchestration (dryrun)", () => {
  it("runs node→install→up in order and pins the config path", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-inst-"));
    const cfg = join(home, ".memkin", "memkin.yaml");
    execFileSync("mkdir", ["-p", join(home, ".memkin")]);
    writeFileSync(cfg, "store:\n  engine: pglite\n");
    const path = minimalPathWithNodeAndNpm();

    const out = execFileSync("sh", ["scripts/install.sh"], {
      env: {
        ...process.env,
        HOME: home,
        MEMKIN_CONFIG: cfg,
        MEMKIN_INSTALL_DRYRUN: "1",
        PATH: path,
      },
      encoding: "utf8",
    });

    expect(out).toContain("DRYRUN: npm install -g memkin@latest");
    // Linux gets --linger so the systemd user service survives SSH logout; the
    // minimal test PATH has no memkin binary, so the npm-exec runner is used.
    const upArgs = process.platform === "linux" ? `up --linger -c ${cfg}` : `up -c ${cfg}`;
    expect(out).toContain(`DRYRUN: npm exec --yes memkin@latest -- ${upArgs}`);
    expect(out).not.toContain("memkin init --web");
  });

  it("adds PATH profile block once (idempotent)", () => {
    const home = mkdtempSync(join(tmpdir(), "memkin-inst-"));
    const cfg = join(home, ".memkin", "memkin.yaml");
    execFileSync("mkdir", ["-p", join(home, ".memkin")]);
    writeFileSync(cfg, "store:\n  engine: pglite\n");
    const path = minimalPathWithNodeAndNpm();

    const env = {
      ...process.env,
      HOME: home,
      MEMKIN_CONFIG: cfg,
      MEMKIN_INSTALL_DRYRUN: "1",
      PATH: path,
    };
    execFileSync("sh", ["scripts/install.sh"], { env, encoding: "utf8" });
    execFileSync("sh", ["scripts/install.sh"], { env, encoding: "utf8" });

    const marker = "# >>> memkin npm global bin >>>";
    const profiles =
      process.platform === "darwin"
        ? [join(home, ".zshrc"), join(home, ".bash_profile")]
        : [join(home, ".profile"), join(home, ".bashrc")];
    for (const profile of profiles) {
      const text = readFileSync(profile, "utf8");
      expect(text.split(marker).length - 1).toBe(1);
    }
  });
});
