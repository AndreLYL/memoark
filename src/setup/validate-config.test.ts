import { describe, expect, it } from "vitest";
import {
  feishuNeedsBotCredentials,
  type PartialConfig,
  validateConfig,
} from "./validate-config.js";

const baseConfig = (feishu: PartialConfig["sources"]) => ({
  llm: { provider: "anthropic", model: "claude" },
  sources: feishu,
});

describe("feishuNeedsBotCredentials", () => {
  it("is false when Feishu is disabled", () => {
    expect(
      feishuNeedsBotCredentials({
        enabled: false,
        sources: { messages: { enabled: true } } as never,
      }),
    ).toBe(false);
  });

  it("is false when only user-scoped sources (mail, message_search, docs) are enabled", () => {
    expect(
      feishuNeedsBotCredentials({
        enabled: true,
        sources: {
          mail: { enabled: true },
          message_search: { enabled: true },
          docs: { enabled: true },
        } as never,
      }),
    ).toBe(false);
  });

  it.each([
    "messages",
    "calendar",
    "tasks",
    "dm",
  ] as const)("is true when bot-scoped source %s is enabled", (src) => {
    expect(
      feishuNeedsBotCredentials({
        enabled: true,
        sources: { [src]: { enabled: true } } as never,
      }),
    ).toBe(true);
  });

  it("is false when Feishu is enabled but no sub-sources are on", () => {
    expect(feishuNeedsBotCredentials({ enabled: true, sources: {} as never })).toBe(false);
  });
});

describe("validateConfig — Feishu credentials", () => {
  it("does NOT require app credentials for a user-only (lark-cli) mail config", () => {
    const result = validateConfig(
      baseConfig({ feishu: { enabled: true, sources: { mail: { enabled: true } } } as never }),
    );
    expect(result.errors).not.toContain(
      "Feishu App ID is required for bot-scoped sources (messages, calendar, tasks, dm)",
    );
    expect(result.valid).toBe(true);
  });

  it("requires app credentials when group messages are enabled without them", () => {
    const result = validateConfig(
      baseConfig({ feishu: { enabled: true, sources: { messages: { enabled: true } } } as never }),
    );
    expect(result.errors).toContain(
      "Feishu App ID is required for bot-scoped sources (messages, calendar, tasks, dm)",
    );
    expect(result.errors).toContain(
      "Feishu App Secret is required for bot-scoped sources (messages, calendar, tasks, dm)",
    );
    expect(result.valid).toBe(false);
  });

  it("passes when bot-scoped sources have credentials", () => {
    const result = validateConfig(
      baseConfig({
        feishu: {
          enabled: true,
          app_id: "cli_x",
          app_secret: "s",
          sources: { dm: { enabled: true } },
        } as never,
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects embedding dimensions above the pgvector HNSW limit", () => {
    const result = validateConfig({
      llm: { provider: "openai", model: "gpt-4o-mini" },
      sources: { "claude-code": { enabled: true } },
      embedding: { dimensions: 2001 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Embedding dimensions cannot exceed 2000. pgvector HNSW indexes support at most 2000 dimensions. For OpenAI text-embedding-3-large, use 1536. Got: 2001.",
    );
  });
});
