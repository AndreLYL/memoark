import { describe, expect, it } from "vitest";
import { servingSubsetHash } from "../../src/daemon/autostart/daemon-state.js";
import {
  assertLoopbackOrThrow,
  resolveDaemonLaunchRuntime,
  resolveMcpHttpRuntime,
} from "../../src/server/mcp-http-runtime.js";

const cfg = {
  bind_host: "127.0.0.1",
  port: 3928,
  allowed_origins: ["http://127.0.0.1:3928"],
  allowed_hosts: ["127.0.0.1:3928"],
  read_only: true,
  auth_token_env: "",
};

describe("resolveMcpHttpRuntime", () => {
  it("flags override YAML: port, read-write, regenerated allowlists", () => {
    const r = resolveMcpHttpRuntime(cfg, {
      mcpBind: "127.0.0.1",
      mcpPort: 4000,
      mcpReadWrite: true,
      daemonInstanceId: "n1",
    });
    expect(r.port).toBe(4000);
    expect(r.readOnly).toBe(false);
    expect(r.allowedHosts).toEqual(["127.0.0.1:4000", "localhost:4000"]);
    expect(r.allowedOrigins).toEqual(["http://127.0.0.1:4000", "http://localhost:4000"]);
    expect(r.instanceId).toBe("n1");
  });
  it("explicit --mcp-allowed-host wins for allowedHosts but origins still regenerated", () => {
    const r = resolveMcpHttpRuntime(cfg, { mcpPort: 4000, mcpAllowedHost: ["foo:4000"] });
    expect(r.allowedHosts).toEqual(["foo:4000"]);
    expect(r.allowedOrigins).toEqual(["http://127.0.0.1:4000", "http://localhost:4000"]);
  });
  it("no flags → YAML values", () => {
    const r = resolveMcpHttpRuntime(cfg, {});
    expect(r.port).toBe(3928);
    expect(r.readOnly).toBe(true);
    expect(r.allowedHosts).toEqual(["127.0.0.1:3928"]);
  });
});

describe("resolveDaemonLaunchRuntime", () => {
  it("forces loopback + read-write regardless of YAML (cfg has read_only: true)", () => {
    const r = resolveDaemonLaunchRuntime({ ...cfg, bind_host: "localhost", read_only: true });
    expect(r.bind).toBe("127.0.0.1");
    expect(r.readOnly).toBe(false);
    expect(r.port).toBe(3928);
    expect(r.allowedHosts).toEqual(["127.0.0.1:3928"]);
  });

  it("port override regenerates hosts like `up --port` does", () => {
    const r = resolveDaemonLaunchRuntime(cfg, { port: 4000 });
    expect(r.port).toBe(4000);
    expect(r.allowedHosts).toEqual(["127.0.0.1:4000", "localhost:4000"]);
  });

  it("up-stored hash and status-recomputed hash agree for the default config (regression)", () => {
    // The default wizard config has read_only: true. `up` stores the hash of the
    // launch runtime; `status` must recompute through the SAME helper. Recomputing
    // from bare config used readOnly=true and mismatched forever.
    const subsetOf = (r: ReturnType<typeof resolveDaemonLaunchRuntime>) => ({
      bind: r.bind,
      port: r.port,
      readOnly: r.readOnly,
      hosts: r.allowedHosts,
    });
    const storedByUp = servingSubsetHash(subsetOf(resolveDaemonLaunchRuntime(cfg, {})));
    const recomputedByStatus = servingSubsetHash(subsetOf(resolveDaemonLaunchRuntime(cfg)));
    expect(recomputedByStatus).toBe(storedByUp);

    // And the bare-config derivation (the old status behavior) really would mismatch:
    const bare = resolveMcpHttpRuntime(cfg, {});
    const oldStatusHash = servingSubsetHash({
      bind: bare.bind,
      port: bare.port,
      readOnly: bare.readOnly,
      hosts: bare.allowedHosts,
    });
    expect(oldStatusHash).not.toBe(storedByUp);
  });
});

describe("assertLoopbackOrThrow", () => {
  it("loopback ok", () => {
    expect(() => assertLoopbackOrThrow({ bind: "127.0.0.1" })).not.toThrow();
  });
  it("localhost ok", () => {
    expect(() => assertLoopbackOrThrow({ bind: "localhost" })).not.toThrow();
  });
  it("non-loopback throws", () => {
    expect(() => assertLoopbackOrThrow({ bind: "0.0.0.0" })).toThrow(/loopback/i);
  });
});
