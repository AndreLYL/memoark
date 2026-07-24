import { existsSync } from "node:fs";
import { validateEmbeddingDimensions } from "../core/embedding-dimensions.js";
import {
  FEISHU_BOT_CREDENTIALS_HINT,
  feishuNeedsBotCredentials,
  type PartialConfig,
} from "../setup/validate-config.js";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface ConfigDiagnostic {
  path: string;
  severity: DiagnosticSeverity;
  message: string;
}

function add(
  diagnostics: ConfigDiagnostic[],
  path: string,
  severity: DiagnosticSeverity,
  message: string,
): void {
  diagnostics.push({ path, severity, message });
}

function isPositiveNumber(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

export function validateDraft(config: PartialConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  if (!config.llm?.provider) {
    add(diagnostics, "llm.provider", "error", "LLM provider is required");
  }
  if (!config.llm?.model) {
    add(diagnostics, "llm.model", "error", "LLM model is required");
  }

  const hasEnabledSource = Object.values(config.sources || {}).some(
    (source) =>
      source && typeof source === "object" && "enabled" in source && source.enabled === true,
  );
  if (!hasEnabledSource) {
    add(diagnostics, "sources", "error", "At least one data source must be enabled");
  }

  for (const sourceId of ["claude-code", "codex", "hermes"] as const) {
    const source = config.sources?.[sourceId];
    if (source?.enabled && source.base_dir && !existsSync(source.base_dir)) {
      add(
        diagnostics,
        `sources.${sourceId}.base_dir`,
        "warning",
        "Source directory does not exist",
      );
    }
  }

  const feishu = config.sources?.feishu;
  if (feishuNeedsBotCredentials(feishu)) {
    if (!feishu?.app_id) {
      add(
        diagnostics,
        "sources.feishu.app_id",
        "error",
        `Feishu App ID is required for ${FEISHU_BOT_CREDENTIALS_HINT}`,
      );
    }
    if (!feishu?.app_secret) {
      add(
        diagnostics,
        "sources.feishu.app_secret",
        "error",
        `Feishu App Secret is required for ${FEISHU_BOT_CREDENTIALS_HINT}`,
      );
    }
  }

  if (
    config.block_builder?.block_gap_minutes !== undefined &&
    !isPositiveNumber(config.block_builder.block_gap_minutes, 1)
  ) {
    add(
      diagnostics,
      "block_builder.block_gap_minutes",
      "error",
      "Block gap minutes must be at least 1",
    );
  }
  if (
    config.block_builder?.max_block_tokens !== undefined &&
    !isPositiveNumber(config.block_builder.max_block_tokens, 100)
  ) {
    add(
      diagnostics,
      "block_builder.max_block_tokens",
      "error",
      "Max block tokens must be at least 100",
    );
  }
  if (
    config.block_builder?.max_block_messages !== undefined &&
    !isPositiveNumber(config.block_builder.max_block_messages, 1)
  ) {
    add(
      diagnostics,
      "block_builder.max_block_messages",
      "error",
      "Max block messages must be at least 1",
    );
  }

  const embeddingDimensionsError = validateEmbeddingDimensions(config.embedding?.dimensions);
  if (embeddingDimensionsError) {
    add(diagnostics, "embedding.dimensions", "error", embeddingDimensionsError);
  }

  if (
    config.server?.http_port !== undefined &&
    (!Number.isInteger(config.server.http_port) ||
      config.server.http_port < 1 ||
      config.server.http_port > 65535)
  ) {
    add(diagnostics, "server.http_port", "error", "HTTP port must be between 1 and 65535");
  }

  return diagnostics;
}
