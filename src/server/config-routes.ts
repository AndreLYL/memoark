import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Hono } from "hono";
import { parse } from "yaml";
import { LarkCliHttpClient, MEMKIN_LARK_DOMAINS } from "../collectors/feishu/lark-cli-client.js";
import { maskDatabaseUrl, maskSecret } from "../config-center/secrets.js";
import { validateDraft } from "../config-center/validation.js";
import { testEmbeddingConnection, testLLMConnection } from "../setup/connection-tests.js";
import { generateConfigYaml } from "../setup/generate-config.js";
import type { PartialConfig } from "../setup/validate-config.js";
import { resolveDefaultEngineForNewInstall } from "../store/managed/new-install.js";

/**
 * Turn a raw lark-cli failure into an actionable message + flags the setup UI can act
 * on, instead of dumping the raw JSON error at the user (a barrier for non-technical
 * users). `needsAuth` drives the in-wizard "Authorize Feishu" flow; `notInstalled`
 * tells the UI the lark binary is missing so the user can skip or install it.
 */
export function friendlyLarkError(raw: string): {
  message: string;
  needsAuth: boolean;
  notInstalled: boolean;
} {
  if (/ENOENT|no such file|not found|spawn\b/i.test(raw)) {
    return {
      message:
        "The Feishu CLI (lark) isn't installed on this machine. Install lark-cli to connect Feishu, or skip this step and use AI-agent sessions only.",
      needsAuth: false,
      notInstalled: true,
    };
  }
  if (/need_user_authorization|token_missing|need_authorization|user_authorization/i.test(raw)) {
    return {
      message:
        'Feishu isn\'t authorized yet. Click "Authorize Feishu" to sign in, then your group chats will load automatically.',
      needsAuth: true,
      notInstalled: false,
    };
  }
  return { message: raw.slice(0, 300).trim(), needsAuth: false, notInstalled: false };
}

export interface ConfigRoutesOpts {
  configPath: string;
  larkBin?: string;
  onSetupComplete?: () => void;
  /** Fired after a successful config write (triggers async reload). Not awaited. */
  onConfigSaved?: () => void;
  /**
   * Override the new-install engine decision (tests). Defaults to
   * resolveDefaultEngineForNewInstall on the real platform/arch/home.
   */
  resolveNewInstallEngine?: () => "managed" | "pglite";
}

export function createConfigRoutes(opts: ConfigRoutesOpts): Hono {
  const app = new Hono();

  app.get("/api/config", (c) => {
    if (!existsSync(opts.configPath)) return c.json({});
    const raw = readFileSync(opts.configPath, "utf-8");
    const parsed = (parse(raw) ?? {}) as PartialConfig;
    if (parsed.llm?.api_key) parsed.llm.api_key = maskSecret(parsed.llm.api_key);
    if (parsed.embedding?.api_key) parsed.embedding.api_key = maskSecret(parsed.embedding.api_key);
    if (parsed.sources?.feishu?.app_secret) {
      parsed.sources.feishu.app_secret = maskSecret(parsed.sources.feishu.app_secret);
    }
    if (parsed.store?.database_url) {
      parsed.store.database_url = maskDatabaseUrl(parsed.store.database_url);
    }
    return c.json(parsed);
  });

  app.post("/api/config", async (c) => {
    const body = await c.req.json<PartialConfig>();

    // Captured before the write: no config file on disk means this save IS the install.
    const isNewInstall = !existsSync(opts.configPath);
    let existing: PartialConfig = {};
    if (!isNewInstall) {
      existing = (parse(readFileSync(opts.configPath, "utf-8")) ?? {}) as PartialConfig;
    }

    const isMasked = (v: string | undefined): boolean =>
      typeof v === "string" && v.includes("****");

    if (isMasked(body.llm?.api_key) && body.llm) {
      body.llm.api_key = existing.llm?.api_key ?? body.llm.api_key;
    }
    if (isMasked(body.embedding?.api_key) && body.embedding) {
      body.embedding.api_key = existing.embedding?.api_key ?? body.embedding.api_key;
    }
    if (isMasked(body.sources?.feishu?.app_secret) && body.sources?.feishu) {
      body.sources.feishu.app_secret =
        existing.sources?.feishu?.app_secret ?? body.sources.feishu.app_secret;
    }
    if (isMasked(body.store?.database_url) && body.store) {
      body.store.database_url = existing.store?.database_url ?? body.store.database_url;
    }

    // The web UI carries no engine concept (its store type only has data_dir), so a
    // save must never downgrade an existing postgres/managed install to the pglite
    // default. Unless the client explicitly sets an engine, carry the on-disk engine
    // and its companion fields (database_url/pool_size/managed) over the posted store.
    if (!isNewInstall && !body.store?.engine && existing.store?.engine) {
      body.store = { ...existing.store, ...body.store };
    }

    const diagnostics = validateDraft(body);
    if (diagnostics.some((d) => d.severity === "error")) {
      return c.json({ ok: false, diagnostics }, 422);
    }

    // First save from the wizard: pick the engine the same way `memkin init` does —
    // managed Postgres wherever the runtime supports it. install.sh runs
    // `memkin init --web`, so this path is the default install path.
    const newInstallOpts = isNewInstall
      ? {
          newInstallEngine:
            opts.resolveNewInstallEngine?.() ??
            resolveDefaultEngineForNewInstall({
              platform: process.platform,
              arch: process.arch,
              home: homedir(),
            }),
        }
      : undefined;

    const yaml = generateConfigYaml(body, newInstallOpts);
    mkdirSync(dirname(opts.configPath), { recursive: true });
    writeFileSync(opts.configPath, yaml, "utf-8");
    opts.onConfigSaved?.();
    return c.json({ ok: true, diagnostics });
  });

  app.post("/api/test/llm", async (c) => {
    const body = await c.req.json<{
      provider: string;
      model: string;
      base_url?: string;
      api_key?: string;
    }>();
    const start = Date.now();
    const result = await testLLMConnection({
      provider: body.provider,
      model: body.model,
      baseUrl: body.base_url,
      apiKey: body.api_key,
    });
    return c.json({ ...result, latency_ms: Date.now() - start });
  });

  app.post("/api/test/embedding", async (c) => {
    const body = await c.req.json<{
      provider: string;
      model?: string;
      base_url?: string;
      api_key?: string;
    }>();
    if (body.provider === "ollama") {
      const baseUrl = body.base_url ?? "http://localhost:11434";
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        return c.json({
          ok: res.ok,
          error: res.ok ? undefined : `Ollama responded with ${res.status}`,
        });
      } catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const result = await testEmbeddingConnection(
      body.base_url ?? "https://api.openai.com/v1",
      body.api_key ?? "",
      body.model ?? "",
    );
    return c.json(result);
  });

  app.get("/api/feishu/health", async (c) => {
    const client = new LarkCliHttpClient(opts.larkBin);
    try {
      const result = await client.healthCheck();
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/feishu/groups", async (c) => {
    const client = new LarkCliHttpClient(opts.larkBin);
    try {
      const result = await client.request<{
        code: number;
        data?: { items?: Array<{ chat_id: string; name: string }> };
      }>("GET", "/open-apis/im/v1/chats", { params: { page_size: "100" } });
      const items = result.data?.items ?? [];
      return c.json({ groups: items.map((i) => ({ id: i.chat_id, name: i.name })) });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const friendly = friendlyLarkError(raw);
      return c.json({ error: friendly.message, ...friendly, raw }, 500);
    }
  });

  // --- In-wizard Feishu authorization (device flow) ------------------------------
  // Lets the user authorize Feishu from the setup UI instead of running
  // `lark auth login` in a terminal — the biggest onboarding barrier.
  app.get("/api/feishu/auth/status", async (c) => {
    const client = new LarkCliHttpClient(opts.larkBin);
    if (!client.isInstalled()) {
      return c.json({ ready: false, notInstalled: true });
    }
    const state = await client.userAuthState();
    return c.json({ ...state, notInstalled: false });
  });

  app.post("/api/feishu/auth/start", async (c) => {
    const client = new LarkCliHttpClient(opts.larkBin);
    if (!client.isInstalled()) {
      return c.json(
        { error: friendlyLarkError("spawn lark ENOENT").message, notInstalled: true },
        400,
      );
    }
    try {
      const { verificationUrl, deviceCode } = await client.authStart(MEMKIN_LARK_DOMAINS);
      return c.json({ verification_url: verificationUrl, device_code: deviceCode });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return c.json({ error: friendlyLarkError(raw).message, raw }, 500);
    }
  });

  app.post("/api/feishu/auth/complete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { device_code?: string };
    if (!body.device_code) {
      return c.json({ ok: false, error: "device_code is required" }, 400);
    }
    const client = new LarkCliHttpClient(opts.larkBin);
    const result = await client.authComplete(body.device_code);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/api/setup/complete", (c) => {
    opts.onSetupComplete?.();
    return c.json({ ok: true });
  });

  return app;
}
