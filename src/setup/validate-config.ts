import type {
  DistillerConfig,
  EmbeddingConfig,
  FeishuSourceConfig,
  LLMConfig,
  McpConfig,
  PrivacyConfig,
  ProfileConfig,
  SchedulerConfig,
  SearchConfig,
  ServerConfig,
  SourceConfig,
  StoreConfig,
} from "../core/config.js";
import { validateEmbeddingDimensions } from "../core/embedding-dimensions.js";

export interface PartialSourcesConfig {
  "claude-code"?: Partial<SourceConfig>;
  codex?: Partial<SourceConfig>;
  hermes?: Partial<SourceConfig>;
  feishu?: Partial<FeishuSourceConfig>;
}

export interface PartialConfig {
  llm?: Partial<LLMConfig>;
  sources?: PartialSourcesConfig;
  privacy?: Partial<PrivacyConfig>;
  store?: Partial<StoreConfig>;
  embedding?: Partial<EmbeddingConfig>;
  server?: Partial<ServerConfig>;
  mcp?: Partial<McpConfig>;
  block_builder?: {
    block_gap_minutes?: number;
    max_block_tokens?: number;
    max_block_messages?: number;
  };
  scheduler?: SchedulerConfig;
  profile?: Partial<ProfileConfig>;
  search?: Partial<SearchConfig>;
  distiller?: Partial<DistillerConfig>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isPublicBindHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(normalized);
}

/**
 * Whether an enabled Feishu config needs bot credentials (app_id + app_secret).
 *
 * Feishu sources split by which client they read through:
 *   - Bot / tenant token (FeishuHttpClient → needs app_id/app_secret): messages, calendar, tasks, dm
 *   - lark-cli user authorization (LarkCliHttpClient → no app credentials): mail, message_search, docs
 *
 * So a user who authorizes only via the in-wizard lark-cli device flow and enables just the
 * user-scoped sources can save a valid config without ever entering App ID / App Secret.
 */
export function feishuNeedsBotCredentials(
  feishu: Partial<FeishuSourceConfig> | undefined,
): boolean {
  if (!feishu?.enabled) return false;
  const s = feishu.sources;
  if (!s) return false;
  return Boolean(s.messages?.enabled || s.calendar?.enabled || s.tasks?.enabled || s.dm?.enabled);
}

export const FEISHU_BOT_CREDENTIALS_HINT = "bot-scoped sources (messages, calendar, tasks, dm)";

export function validateConfig(config: PartialConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.llm?.provider) {
    errors.push("LLM provider is required");
  }
  if (!config.llm?.model) {
    errors.push("LLM model is required");
  }

  const hasEnabledSource = Object.values(config.sources || {}).some(
    (source) =>
      source && typeof source === "object" && "enabled" in source && source.enabled === true,
  );
  if (!hasEnabledSource) {
    errors.push("At least one data source must be enabled");
  }

  const feishu = config.sources?.feishu;
  if (feishuNeedsBotCredentials(feishu)) {
    if (!feishu?.app_id) {
      errors.push(`Feishu App ID is required for ${FEISHU_BOT_CREDENTIALS_HINT}`);
    }
    if (!feishu?.app_secret) {
      errors.push(`Feishu App Secret is required for ${FEISHU_BOT_CREDENTIALS_HINT}`);
    }
  }

  const mcpHttp = config.mcp?.http;
  if (mcpHttp?.enabled) {
    if (!mcpHttp.allowed_origins || mcpHttp.allowed_origins.length === 0) {
      errors.push("MCP HTTP allowed_origins must contain at least one trusted origin");
    }
    if (!mcpHttp.allowed_hosts || mcpHttp.allowed_hosts.length === 0) {
      errors.push("MCP HTTP allowed_hosts must contain at least one trusted host");
    }
    if (isPublicBindHost(mcpHttp.bind_host) && !mcpHttp.auth_token_env) {
      errors.push("MCP HTTP public bind requires auth_token_env");
    }
  }

  const embeddingDimensionsError = validateEmbeddingDimensions(config.embedding?.dimensions);
  if (embeddingDimensionsError) {
    errors.push(embeddingDimensionsError);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
