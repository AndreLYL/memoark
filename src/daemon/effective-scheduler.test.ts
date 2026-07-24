import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config, SchedulerConfig } from "../core/config.js";
import { deriveSchedulableSources, effectiveSchedulerConfig } from "./effective-scheduler.js";
import { Scheduler } from "./scheduler.js";

const scheduler = (sources: SchedulerConfig["sources"] = {}): SchedulerConfig => ({
  enabled: true,
  tick_interval_secs: 60,
  defaults: { interval_secs: 3600 },
  sources,
});

const cfg = (sources: Config["sources"], sched?: SchedulerConfig): Config =>
  ({ sources, scheduler: sched }) as Config;

function effectiveOrThrow(config: Config): SchedulerConfig {
  const effective = effectiveSchedulerConfig(config);
  if (!effective) throw new Error("expected an effective scheduler config");
  return effective;
}

describe("deriveSchedulableSources", () => {
  it("derives all agent sources from a default fresh-install config", () => {
    const derived = deriveSchedulableSources(
      cfg({
        "claude-code": { enabled: true },
        codex: { enabled: true },
        hermes: { enabled: true },
      }),
    );
    expect(Object.keys(derived).sort()).toEqual(["claude-code", "codex", "hermes"]);
  });

  it("treats a missing agent entry as enabled (mirrors bootstrapCollectors)", () => {
    const derived = deriveSchedulableSources(cfg({}));
    expect(Object.keys(derived).sort()).toEqual(["claude-code", "codex", "hermes"]);
  });

  it("skips a channel disabled in sources config", () => {
    const derived = deriveSchedulableSources(
      cfg({ "claude-code": { enabled: true }, codex: { enabled: false } }),
    );
    expect(derived.codex).toBeUndefined();
    expect(derived["claude-code"]).toBeDefined();
  });

  it("derives feishu only when enabled with an app_id", () => {
    const feishuBase = { app_id: "cli_x", app_secret: "s", sources: {} };
    expect(
      deriveSchedulableSources(cfg({ feishu: { ...feishuBase, enabled: false } })).feishu,
    ).toBeUndefined();
    expect(
      deriveSchedulableSources(cfg({ feishu: { ...feishuBase, enabled: true, app_id: "" } }))
        .feishu,
    ).toBeUndefined();
    expect(
      deriveSchedulableSources(cfg({ feishu: { ...feishuBase, enabled: true } })).feishu,
    ).toBeDefined();
  });

  it("derives feishu.docs only when both feishu and docs are enabled", () => {
    const feishu = {
      enabled: true,
      app_id: "cli_x",
      app_secret: "s",
      sources: { docs: { enabled: true } },
    };
    expect(deriveSchedulableSources(cfg({ feishu }))["feishu.docs"]).toBeDefined();
    expect(
      deriveSchedulableSources(
        cfg({ feishu: { ...feishu, sources: { docs: { enabled: false } } } }),
      )["feishu.docs"],
    ).toBeUndefined();
  });
});

describe("effectiveSchedulerConfig", () => {
  it("returns undefined when the config has no scheduler block", () => {
    expect(effectiveSchedulerConfig(cfg({ "claude-code": { enabled: true } }))).toBeUndefined();
  });

  it("fills an empty sources map (fresh install) from the enabled channels", () => {
    const effective = effectiveOrThrow(
      cfg({ "claude-code": { enabled: true }, codex: { enabled: true } }, scheduler({})),
    );
    expect(Object.keys(effective.sources).sort()).toEqual(["claude-code", "codex", "hermes"]);
    expect(effective.enabled).toBe(true);
  });

  it("keeps explicit per-source overrides on top of derived entries", () => {
    const effective = effectiveOrThrow(
      cfg(
        { "claude-code": { enabled: true } },
        scheduler({ "claude-code": { interval_secs: 900 }, codex: { enabled: false } }),
      ),
    );
    expect(effective.sources["claude-code"]).toEqual({ interval_secs: 900 });
    expect(effective.sources.codex).toEqual({ enabled: false });
  });

  it("preserves a hand-written source id the derivation does not know", () => {
    const effective = effectiveOrThrow(
      cfg({ "claude-code": { enabled: true } }, scheduler({ custom: { interval_secs: 60 } })),
    );
    expect(effective.sources.custom).toEqual({ interval_secs: 60 });
  });
});

describe("Scheduler built from the effective config (fresh-install regression)", () => {
  it("schedules the enabled channels even though scheduler.sources is empty", () => {
    // The exact shape the web setup wizard saves: auto-fetch ON, sources {} —
    // before the derivation the Scheduler had zero schedules and serve never
    // auto-captured any channel.
    const dir = mkdtempSync(join(tmpdir(), "memkin-effective-sched-"));
    try {
      const effective = effectiveOrThrow(
        cfg(
          { "claude-code": { enabled: true }, codex: { enabled: true }, hermes: { enabled: true } },
          scheduler({}),
        ),
      );
      const s = new Scheduler(effective, dir);
      expect(s.getSourceIds().sort()).toEqual(["claude-code", "codex", "hermes"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
