import { describe, expect, it, vi } from "vitest";
import { ReloadManager, runtimeSignature, storeSignature } from "./reload-manager.js";
import { type ServeRuntime, ServeRuntimeHolder } from "./serve-runtime.js";

const cfg = (over: Record<string, unknown> = {}) =>
  ({
    llm: { provider: "openai", model: "gpt-4o", api_key: "sk-a" },
    embedding: { provider: "openai", model: "e", api_key: "sk-b" },
    sources: { feishu: { enabled: true, app_secret: "s1", sources: { dm: { enabled: true } } } },
    privacy: { mask: true },
    block_builder: { block_gap_minutes: 30 },
    scheduler: {
      enabled: true,
      tick_interval_secs: 60,
      defaults: { interval_secs: 3600 },
      sources: { feishu: { interval_secs: 900 } },
    },
    ...over,
  }) as never;

function makeRuntime(onReconcile: (n: number) => void, label: string): ServeRuntime {
  let disposed = false;
  return {
    scheduler: {
      reconcile: () => onReconcile(1),
      drain: async () => {},
      start: async () => {},
    } as never,
    chatNameRefreshJob: undefined,
    getDaemonStatus: () => undefined,
    dispose: async () => {
      disposed = true;
      void disposed;
      void label;
    },
  };
}

// Fixtures: sameSig* differ ONLY in scheduler.sources (same signature → Tier 1).
// tier2* differ in llm.api_key (different signature → Tier 2).
const baseSigConfig = {
  llm: { provider: "openai", model: "gpt-4o", api_key: "sk-a" },
  embedding: { provider: "openai", model: "e", api_key: "sk-b" },
  sources: { feishu: { enabled: true, app_secret: "s1" } },
  privacy: {},
  block_builder: { block_gap_minutes: 30 },
  scheduler: {
    enabled: true,
    tick_interval_secs: 60,
    defaults: { interval_secs: 3600 },
    sources: { feishu: { interval_secs: 900 } },
  },
} as never;
const sameSigConfig = baseSigConfig;
const sameSigConfig2 = {
  ...(baseSigConfig as Record<string, unknown>),
  scheduler: {
    enabled: true,
    tick_interval_secs: 60,
    defaults: { interval_secs: 3600 },
    sources: { feishu: { interval_secs: 300 } },
  },
} as never;
const tier2Config = {
  ...(baseSigConfig as Record<string, unknown>),
  llm: { provider: "openai", model: "gpt-4o", api_key: "sk-CHANGED" },
} as never;
const tier2ConfigB = {
  ...(baseSigConfig as Record<string, unknown>),
  llm: { provider: "openai", model: "gpt-4o", api_key: "sk-CHANGED-2" },
} as never;

describe("ReloadManager", () => {
  it("Tier 1: same signature → calls scheduler.reconcile, no rebuild", async () => {
    let reconciled = 0;
    const holder = new ServeRuntimeHolder(makeRuntime(() => reconciled++, "init"));
    let rebuilds = 0;
    const mgr = new ReloadManager({
      holder,
      currentConfig: () => sameSigConfig,
      buildRuntime: async () => {
        rebuilds++;
        return makeRuntime(() => {}, "rebuilt");
      },
    });
    await mgr.run(sameSigConfig2);
    expect(reconciled).toBe(1);
    expect(rebuilds).toBe(0);
  });

  it("Tier 2: signature change → drain + rebuild + swap + dispose old", async () => {
    const drained: string[] = [];
    const holder = new ServeRuntimeHolder({
      ...makeRuntime(() => {}, "old"),
      scheduler: {
        reconcile: () => {},
        drain: async () => {
          drained.push("old");
        },
        start: async () => {},
      } as never,
    });
    let rebuilds = 0;
    const mgr = new ReloadManager({
      holder,
      currentConfig: () => baseSigConfig,
      buildRuntime: async () => {
        rebuilds++;
        return makeRuntime(() => {}, "new");
      },
    });
    await mgr.run(tier2Config);
    expect(drained).toEqual(["old"]);
    expect(rebuilds).toBe(1);
  });

  it("serializes concurrent runs (single-flight)", async () => {
    const order: string[] = [];
    const holder = new ServeRuntimeHolder(makeRuntime(() => {}, "init"));
    const mgr = new ReloadManager({
      holder,
      currentConfig: () => baseSigConfig,
      buildRuntime: async () => {
        order.push("build-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("build-end");
        return makeRuntime(() => {}, "n");
      },
    });
    await Promise.all([mgr.run(tier2Config), mgr.run(tier2ConfigB)]);
    expect(order).toEqual(["build-start", "build-end", "build-start", "build-end"]);
  });

  describe("ReloadManager race regressions", () => {
    it("C2: build before drain; new scheduler starts only after old is drained (no double-run)", async () => {
      const events: string[] = [];
      const holder = new ServeRuntimeHolder({
        scheduler: {
          reconcile: () => {},
          drain: async () => {
            events.push("drain-start");
            await new Promise((r) => setTimeout(r, 10));
            events.push("drain-end");
          },
          start: async () => {},
        } as never,
        chatNameRefreshJob: undefined,
        getDaemonStatus: () => undefined,
        dispose: async () => {
          events.push("dispose-old");
        },
      });
      const mgr = new ReloadManager({
        holder,
        currentConfig: () => baseSigConfig,
        buildRuntime: async () => {
          events.push("build");
          return {
            scheduler: {
              reconcile: () => {},
              drain: async () => {},
              start: async () => {
                events.push("start-new");
              },
            } as never,
            chatNameRefreshJob: undefined,
            getDaemonStatus: () => undefined,
            dispose: async () => {},
          };
        },
      });
      await mgr.run(tier2Config); // tier2Config has scheduler.enabled: true
      expect(events).toEqual(["build", "drain-start", "drain-end", "start-new", "dispose-old"]);
    });

    it("Tier 1 reconciles with the EFFECTIVE scheduler config (derived sources, not the raw map)", async () => {
      let received: { sources?: Record<string, unknown> } | undefined;
      const holder = new ServeRuntimeHolder({
        ...makeRuntime(() => {}, "init"),
        scheduler: {
          reconcile: (c: { sources?: Record<string, unknown> }) => {
            received = c;
          },
          drain: async () => {},
          start: async () => {},
        } as never,
      });
      const mgr = new ReloadManager({
        holder,
        currentConfig: () => sameSigConfig,
        buildRuntime: async () => makeRuntime(() => {}, "rebuilt"),
      });
      await mgr.run(sameSigConfig2);
      // Raw block lists only feishu; the effective map must add the derived
      // agent channels — reconciling with the raw map would delete their schedules.
      expect(Object.keys(received?.sources ?? {}).sort()).toEqual([
        "claude-code",
        "codex",
        "feishu",
        "hermes",
      ]);
      expect(received?.sources?.feishu).toEqual({ interval_secs: 300 });
    });

    it("scheduler.enabled flip forces Tier 2 (rebuild), not a reconcile", async () => {
      let reconciled = 0;
      let rebuilds = 0;
      let startedNew = 0;
      const holder = new ServeRuntimeHolder(makeRuntime(() => reconciled++, "init"));
      const disabledConfig = {
        ...(baseSigConfig as Record<string, unknown>),
        scheduler: {
          enabled: false,
          tick_interval_secs: 60,
          defaults: { interval_secs: 3600 },
          sources: {},
        },
      } as never;
      const mgr = new ReloadManager({
        holder,
        currentConfig: () => disabledConfig,
        buildRuntime: async () => {
          rebuilds++;
          return {
            ...makeRuntime(() => {}, "new"),
            scheduler: {
              reconcile: () => {},
              drain: async () => {},
              start: async () => {
                startedNew++;
              },
            } as never,
          };
        },
      });
      // Same runtime signature, only scheduler.enabled flips false → true.
      await mgr.run(baseSigConfig);
      expect(reconciled).toBe(0);
      expect(rebuilds).toBe(1);
      expect(startedNew).toBe(1); // rebuilt runtime is started because enabled=true
    });

    it("Tier 2 build failure leaves old runtime untouched", async () => {
      let oldDrained = false;
      const holder = new ServeRuntimeHolder({
        scheduler: {
          reconcile: () => {},
          drain: async () => {
            oldDrained = true;
          },
          start: async () => {},
        } as never,
        chatNameRefreshJob: undefined,
        getDaemonStatus: () => undefined,
        dispose: async () => {},
      });
      const original = holder.current;
      const mgr = new ReloadManager({
        holder,
        currentConfig: () => baseSigConfig,
        buildRuntime: async () => {
          throw new Error("invalid api_key");
        },
      });
      await expect(mgr.run(tier2Config)).rejects.toThrow("invalid api_key");
      expect(oldDrained).toBe(false); // old scheduler never drained
      expect(holder.current).toBe(original); // holder still points at old runtime
    });
  });
});

describe("runtimeSignature", () => {
  it("is stable when only scheduler fields change (→ Tier 1)", () => {
    const a = runtimeSignature(cfg());
    const b = runtimeSignature(
      cfg({
        scheduler: {
          enabled: true,
          tick_interval_secs: 60,
          defaults: { interval_secs: 3600 },
          sources: { feishu: { interval_secs: 300 } },
        },
      }),
    );
    expect(a).toBe(b);
  });

  it("changes when llm.api_key changes (→ Tier 2)", () => {
    const a = runtimeSignature(cfg());
    const b = runtimeSignature(
      cfg({ llm: { provider: "openai", model: "gpt-4o", api_key: "sk-CHANGED" } }),
    );
    expect(a).not.toBe(b);
  });

  it("changes when feishu app_secret changes (→ Tier 2)", () => {
    const a = runtimeSignature(cfg());
    const b = runtimeSignature(
      cfg({
        sources: {
          feishu: { enabled: true, app_secret: "s2", sources: { dm: { enabled: true } } },
        },
      }),
    );
    expect(a).not.toBe(b);
  });
});

describe("storeSignature", () => {
  it("is stable for equal store configs", () => {
    const a = storeSignature(cfg({ store: { engine: "pglite", data_dir: "~/.memkin/data" } }));
    const b = storeSignature(cfg({ store: { engine: "pglite", data_dir: "~/.memkin/data" } }));
    expect(a).toBe(b);
  });

  it("differs when engine changes (pglite → managed)", () => {
    const a = storeSignature(cfg({ store: { engine: "pglite" } }));
    const b = storeSignature(cfg({ store: { engine: "managed" } }));
    expect(a).not.toBe(b);
  });

  it("differs when database_url changes", () => {
    const a = storeSignature(cfg({ store: { engine: "postgres", database_url: "postgres://a" } }));
    const b = storeSignature(cfg({ store: { engine: "postgres", database_url: "postgres://b" } }));
    expect(a).not.toBe(b);
  });

  it("differs when managed sub-config changes", () => {
    const a = storeSignature(cfg({ store: { engine: "managed", managed: { runtime_dir: "/a" } } }));
    const b = storeSignature(cfg({ store: { engine: "managed", managed: { runtime_dir: "/b" } } }));
    expect(a).not.toBe(b);
  });
});

describe("ReloadManager store restart-required", () => {
  const baseConfig = {
    ...baseSigConfig,
    store: { engine: "pglite", data_dir: "~/.memkin/data" },
  } as never;

  const managedConfig = {
    ...baseSigConfig,
    store: { engine: "managed" },
  } as never;

  it("calls onRestartRequired once when store.engine changes pglite→managed", async () => {
    const holder = new ServeRuntimeHolder(makeRuntime(() => {}, "init"));
    const onRestartRequired = vi.fn();
    const mgr = new ReloadManager({
      holder,
      currentConfig: () => baseConfig,
      buildRuntime: async () => makeRuntime(() => {}, "rebuilt"),
      onRestartRequired,
    });
    await mgr.run(managedConfig);
    expect(onRestartRequired).toHaveBeenCalledOnce();
    expect(onRestartRequired).toHaveBeenCalledWith({ changed: "store" });
  });

  it("does NOT re-fire onRestartRequired when applying the same store change again", async () => {
    const holder = new ServeRuntimeHolder(makeRuntime(() => {}, "init"));
    const onRestartRequired = vi.fn();
    const mgr = new ReloadManager({
      holder,
      currentConfig: () => baseConfig,
      buildRuntime: async () => makeRuntime(() => {}, "rebuilt"),
      onRestartRequired,
    });
    // First apply: store changed → fires once
    await mgr.run(managedConfig);
    expect(onRestartRequired).toHaveBeenCalledTimes(1);
    // Second apply with identical store config → does NOT re-fire
    await mgr.run(managedConfig);
    expect(onRestartRequired).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onRestartRequired when only non-store fields change (e.g. embedding)", async () => {
    const holder = new ServeRuntimeHolder(makeRuntime(() => {}, "init"));
    const onRestartRequired = vi.fn();
    const embeddingChangedConfig = {
      ...baseConfig,
      embedding: { provider: "openai", model: "text-embedding-3-large", api_key: "sk-b" },
    } as never;
    const mgr = new ReloadManager({
      holder,
      currentConfig: () => baseConfig,
      buildRuntime: async () => makeRuntime(() => {}, "rebuilt"),
      onRestartRequired,
    });
    await mgr.run(embeddingChangedConfig);
    expect(onRestartRequired).not.toHaveBeenCalled();
  });
});
