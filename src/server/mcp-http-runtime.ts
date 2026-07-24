import { isPublicBindHost } from "./mcp-http.js";

export interface McpHttpConfigSubset {
  bind_host: string;
  port: number;
  allowed_origins: string[];
  allowed_hosts: string[];
  read_only: boolean;
  auth_token_env?: string;
}

export interface McpHttpFlags {
  mcpBind?: string;
  mcpPort?: number;
  mcpReadWrite?: boolean;
  mcpAllowedHost?: string[];
  daemonInstanceId?: string;
}

export interface McpHttpRuntime {
  bind: string;
  port: number;
  allowedOrigins: string[];
  allowedHosts: string[];
  readOnly: boolean;
  instanceId?: string;
}

export function resolveMcpHttpRuntime(
  cfg: McpHttpConfigSubset,
  flags: McpHttpFlags,
): McpHttpRuntime {
  const bind = flags.mcpBind ?? cfg.bind_host;
  const port = flags.mcpPort ?? cfg.port;
  const readOnly = flags.mcpReadWrite ? false : cfg.read_only;
  // When the port is overridden, explicit --mcp-allowed-host wins for allowedHosts.
  // allowedOrigins are ALWAYS regenerated for the resolved port (independent of explicit hosts).
  const allowedHosts =
    flags.mcpAllowedHost && flags.mcpAllowedHost.length > 0
      ? flags.mcpAllowedHost
      : flags.mcpPort !== undefined
        ? [`127.0.0.1:${port}`, `localhost:${port}`]
        : cfg.allowed_hosts;
  const allowedOrigins =
    flags.mcpPort !== undefined
      ? [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
      : cfg.allowed_origins;
  return { bind, port, allowedOrigins, allowedHosts, readOnly, instanceId: flags.daemonInstanceId };
}

/**
 * The MCP HTTP runtime exactly as `memkin up` launches the always-on daemon:
 * loopback bind and read-write are forced by launch flags (`--mcp-bind
 * 127.0.0.1 --mcp-read-write`), regardless of what the YAML says.
 *
 * BOTH sides of the serving-subset drift check must derive their hash from
 * this function — `up` when storing daemon.json and `status` when recomputing.
 * `up` used to hardcode `readOnly: false` while `status` re-read
 * `cfg.read_only` (true in the default config), so the hashes could never
 * match and "Serving subset changed" showed permanently.
 */
export function resolveDaemonLaunchRuntime(
  cfg: McpHttpConfigSubset,
  opts: { port?: number } = {},
): McpHttpRuntime {
  const resolved = resolveMcpHttpRuntime(cfg, { mcpPort: opts.port });
  return { ...resolved, bind: "127.0.0.1", readOnly: false };
}

export function assertLoopbackOrThrow(rt: { bind: string }): void {
  if (isPublicBindHost(rt.bind)) {
    throw new Error(
      `Refusing to start: bind host "${rt.bind}" is not loopback. ` +
        `Memkin's always-on daemon is loopback-only (127.0.0.1). Remote access is not supported in this version.`,
    );
  }
}
