import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { createConfigRoutes, friendlyLarkError } from "./config-routes.js";

vi.mock("../setup/connection-tests.js", () => ({
  testLLMConnection: vi.fn().mockResolvedValue({ ok: true }),
  testEmbeddingConnection: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../collectors/feishu/lark-cli-client.js", () => ({
  LarkCliHttpClient: vi.fn().mockImplementation(() => ({
    healthCheck: vi.fn().mockResolvedValue({ ok: true, message: "lark-cli user auth active" }),
    request: vi.fn().mockResolvedValue({
      code: 0,
      data: { items: [{ chat_id: "oc_abc", name: "Team Chat" }] },
    }),
  })),
}));

describe("createConfigRoutes", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `memkin-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "memkin.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/config returns {} when file missing", async () => {
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("GET /api/config returns parsed YAML when file exists", async () => {
    writeFileSync(configPath, "llm:\n  provider: openai\n  model: gpt-4o\n");
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/config");
    const data = (await res.json()) as { llm: { provider: string } };
    expect(data.llm?.provider).toBe("openai");
  });

  it("GET /api/config masks api_key in response", async () => {
    writeFileSync(
      configPath,
      "llm:\n  provider: openai\n  model: gpt-4o\n  api_key: sk-verylongsecret\n",
    );
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/config");
    const data = (await res.json()) as { llm: { api_key: string } };
    expect(data.llm?.api_key).not.toBe("sk-verylongsecret");
    expect(data.llm?.api_key).toContain("****");
  });

  it("POST /api/config writes file and returns ok when valid", async () => {
    const app = createConfigRoutes({ configPath });
    const config = {
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        api_key: "sk-test",
        base_url: "https://api.openai.com/v1",
      },
      sources: { "claude-code": { enabled: true } },
      embedding: {
        provider: "openai",
        model: "text-embedding-3-large",
        dimensions: 1536,
        api_key: "sk-test",
        base_url: "https://api.openai.com/v1",
      },
    };
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  });

  it("POST /api/config returns 422 when llm.provider missing", async () => {
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const data = (await res.json()) as { ok: boolean; diagnostics: Array<{ severity: string }> };
    expect(data.ok).toBe(false);
    expect(data.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("POST /api/config returns 422 for embedding dimensions above the HNSW limit", async () => {
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llm: { provider: "openai", model: "gpt-4o-mini" },
        sources: { "claude-code": { enabled: true } },
        embedding: { dimensions: 2001 },
      }),
    });
    expect(res.status).toBe(422);
    const data = (await res.json()) as {
      ok: boolean;
      diagnostics: Array<{ path: string; message: string }>;
    };
    expect(data.ok).toBe(false);
    expect(data.diagnostics).toContainEqual({
      path: "embedding.dimensions",
      severity: "error",
      message:
        "Embedding dimensions cannot exceed 2000. pgvector HNSW indexes support at most 2000 dimensions. For OpenAI text-embedding-3-large, use 1536. Got: 2001.",
    });
  });

  it("POST /api/test/llm returns ok with latency_ms", async () => {
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/test/llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-4o-mini", api_key: "sk-test" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; latency_ms: number };
    expect(data.ok).toBe(true);
    expect(typeof data.latency_ms).toBe("number");
  });

  it("GET /api/feishu/health returns lark auth status", async () => {
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/feishu/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("GET /api/feishu/groups maps chat_id to id", async () => {
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/feishu/groups");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { groups: Array<{ id: string; name: string }> };
    expect(data.groups).toEqual([{ id: "oc_abc", name: "Team Chat" }]);
  });

  it("POST /api/setup/complete calls onSetupComplete", async () => {
    const onSetupComplete = vi.fn();
    const app = createConfigRoutes({ configPath, onSetupComplete });
    const res = await app.request("/api/setup/complete", { method: "POST" });
    expect(res.status).toBe(200);
    expect(onSetupComplete).toHaveBeenCalledOnce();
  });

  it("POST /api/test/embedding returns ok", async () => {
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/test/embedding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("POST /api/config preserves on-disk api_key when masked value sent", async () => {
    // Write initial config with a real API key
    writeFileSync(
      configPath,
      "llm:\n  provider: openai\n  model: gpt-4o\n  api_key: sk-realkey12345\n",
    );
    const app = createConfigRoutes({ configPath });
    // Send a save request with a masked key (as if loaded from GET then saved)
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llm: { provider: "openai", model: "gpt-4o-updated", api_key: "sk-r****" },
        sources: { "claude-code": { enabled: true } },
        embedding: {
          provider: "openai",
          model: "text-embedding-3-large",
          dimensions: 1536,
          base_url: "https://api.openai.com/v1",
          api_key: "sk-test",
        },
      }),
    });
    expect(res.status).toBe(200);
    // The saved file should have the real key, not the masked one
    const saved = readFileSync(configPath, "utf-8");
    expect(saved).toContain("sk-realkey12345");
    expect(saved).not.toContain("sk-r****");
  });

  it("GET /api/config masks feishu app_secret", async () => {
    writeFileSync(
      configPath,
      "sources:\n  feishu:\n    app_id: cli_abc\n    app_secret: supersecretvalue\n",
    );
    const app = createConfigRoutes({ configPath });
    const res = await app.request("/api/config");
    const data = (await res.json()) as { sources: { feishu: { app_secret: string } } };
    expect(data.sources?.feishu?.app_secret).not.toBe("supersecretvalue");
    expect(data.sources?.feishu?.app_secret).toContain("****");
  });

  it("POST /api/config fires onConfigSaved after writing, returns ok immediately", async () => {
    const onConfigSaved = vi.fn();
    const app = createConfigRoutes({ configPath, onConfigSaved });
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llm: {
          provider: "openai",
          model: "gpt-4o-mini",
          api_key: "sk-test",
          base_url: "https://api.openai.com/v1",
        },
        sources: { "claude-code": { enabled: true } },
        embedding: {
          provider: "openai",
          model: "text-embedding-3-large",
          dimensions: 1536,
          api_key: "sk-test",
          base_url: "https://api.openai.com/v1",
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(onConfigSaved).toHaveBeenCalledOnce();
  });

  it("POST /api/config does NOT fire onConfigSaved on 422", async () => {
    const onConfigSaved = vi.fn();
    const app = createConfigRoutes({ configPath, onConfigSaved });
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(422);
    expect(onConfigSaved).not.toHaveBeenCalled();
  });

  // ---- store.engine: new-install default + downgrade protection ----------------

  /** Minimal body that passes validateDraft; store shape varies per test. */
  const validBody = (store?: Record<string, unknown>) => ({
    llm: {
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "sk-test",
      base_url: "https://api.openai.com/v1",
    },
    sources: { "claude-code": { enabled: true } },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 1536,
      api_key: "sk-test",
      base_url: "https://api.openai.com/v1",
    },
    ...(store ? { store } : {}),
  });

  const postConfig = (app: ReturnType<typeof createConfigRoutes>, body: unknown) =>
    app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const savedStore = () =>
    (parse(readFileSync(configPath, "utf-8")) as { store: Record<string, unknown> }).store;

  it("POST /api/config on a NEW install injects the platform default engine (managed)", async () => {
    const resolveNewInstallEngine = vi.fn(() => "managed" as const);
    const app = createConfigRoutes({ configPath, resolveNewInstallEngine });
    // No store at all in the body — exactly what the web wizard sends.
    const res = await postConfig(app, validBody());
    expect(res.status).toBe(200);
    expect(resolveNewInstallEngine).toHaveBeenCalledOnce();
    expect(savedStore().engine).toBe("managed");
  });

  it("POST /api/config on a NEW install honours an explicit engine over the injected default", async () => {
    const app = createConfigRoutes({ configPath, resolveNewInstallEngine: () => "managed" });
    const res = await postConfig(app, validBody({ engine: "pglite", data_dir: "~/.memkin/data" }));
    expect(res.status).toBe(200);
    expect(savedStore().engine).toBe("pglite");
  });

  it("POST /api/config re-save preserves an existing postgres engine when the client omits it", async () => {
    writeFileSync(
      configPath,
      [
        "llm:",
        "  provider: openai",
        "  model: gpt-4o",
        "store:",
        "  engine: postgres",
        "  database_url: postgres://memkin:pw@127.0.0.1:5432/memkin",
        "  pool_size: 5",
        "",
      ].join("\n"),
    );
    const app = createConfigRoutes({ configPath, resolveNewInstallEngine: () => "managed" });
    // StorageSection-style save: store is replaced with just {data_dir}.
    const res = await postConfig(app, validBody({ data_dir: "~/.memkin/data" }));
    expect(res.status).toBe(200);
    const store = savedStore();
    expect(store.engine).toBe("postgres");
    expect(store.database_url).toBe("postgres://memkin:pw@127.0.0.1:5432/memkin");
    expect(store.pool_size).toBe(5);
  });

  it("POST /api/config re-save preserves a managed engine and its runtime_dir", async () => {
    writeFileSync(
      configPath,
      ["store:", "  engine: managed", "  managed:", "    runtime_dir: /opt/memkin-pg", ""].join(
        "\n",
      ),
    );
    const app = createConfigRoutes({ configPath });
    const res = await postConfig(app, validBody({ data_dir: "~/.memkin/data" }));
    expect(res.status).toBe(200);
    const store = savedStore();
    expect(store.engine).toBe("managed");
    expect(store.managed).toEqual({ runtime_dir: "/opt/memkin-pg" });
  });

  it("POST /api/config re-save of an engine-less config stays pglite (no surprise engine switch)", async () => {
    writeFileSync(configPath, "llm:\n  provider: openai\n  model: gpt-4o\n");
    const resolveNewInstallEngine = vi.fn(() => "managed" as const);
    const app = createConfigRoutes({ configPath, resolveNewInstallEngine });
    const res = await postConfig(app, validBody());
    expect(res.status).toBe(200);
    // New-install injection must not fire for an existing config.
    expect(resolveNewInstallEngine).not.toHaveBeenCalled();
    expect(savedStore().engine).toBe("pglite");
  });
});

describe("friendlyLarkError", () => {
  it("maps missing user authorization to an actionable, auth-flagged message", () => {
    const raw =
      'lark-cli failed: {"error":{"type":"authentication","subtype":"token_missing","message":"need_user_authorization (user: ou_x)"}}';
    const r = friendlyLarkError(raw);
    expect(r.needsAuth).toBe(true);
    expect(r.notInstalled).toBe(false);
    expect(r.message).toMatch(/Authorize Feishu/i);
  });

  it("flags a missing lark binary so the UI can offer to skip or install", () => {
    const r = friendlyLarkError("lark-cli failed: spawn lark ENOENT");
    expect(r.notInstalled).toBe(true);
    expect(r.needsAuth).toBe(false);
    expect(r.message).toMatch(/isn't installed/i);
  });

  it("passes an unknown error through as a trimmed snippet", () => {
    const r = friendlyLarkError("some unexpected failure happened");
    expect(r.needsAuth).toBe(false);
    expect(r.notInstalled).toBe(false);
    expect(r.message).toBe("some unexpected failure happened");
  });
});
