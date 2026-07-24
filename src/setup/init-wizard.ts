import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveConfigPath } from "../core/config.js";
import { normalizeProvider } from "../extractors/providers/index.js";
import { resolveDefaultEngineForNewInstall } from "../store/managed/new-install.js";
import { runEmbeddingAssessment } from "./assess-hardware.js";
import {
  checkOllamaModel,
  checkOllamaRunning,
  testEmbeddingConnection,
  testLLMConnection,
} from "./connection-tests.js";
import { type DetectedApiKeys, detectApiKeys } from "./detect-api-keys.js";
import { detectCurrentRuntime } from "./detect-runtime.js";
import { type DetectedSource, detectSources } from "./detect-sources.js";
import { generateConfigYaml } from "./generate-config.js";
import { createPrompt, type Prompt } from "./terminal.js";
import { type PartialConfig, validateConfig } from "./validate-config.js";

export interface InitOptions {
  auto?: boolean;
  force?: boolean;
  configPath?: string;
  tui?: boolean;
  input?: Readable;
  output?: Writable;
  env?: NodeJS.ProcessEnv;
  registerCommand?: boolean;
}

type SourceConfig = NonNullable<PartialConfig["sources"]>;

const LLM_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-haiku-20240307",
  mock: "mock-model",
};

// Same defaults the web setup wizard saves (Review step, auto-fetch ON): serve's
// scheduler derives the actual source list from the enabled channels, so an empty
// `sources` map here means "all enabled channels at the default interval".
const DEFAULT_SCHEDULER: NonNullable<PartialConfig["scheduler"]> = {
  enabled: true,
  tick_interval_secs: 60,
  defaults: { interval_secs: 3600 },
  sources: {},
};
const OPENAI_API_KEY_PLACEHOLDER = "$" + "{OPENAI_API_KEY}";
const ANTHROPIC_API_KEY_PLACEHOLDER = "$" + "{ANTHROPIC_API_KEY}";

function write(output: Writable, message = ""): void {
  output.write(`${message}\n`);
}

export function getConfigPath(customPath?: string): string {
  return resolveConfigPath(customPath);
}

export function isFirstRun(customPath?: string): boolean {
  return !existsSync(getConfigPath(customPath));
}

function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function sourceConfigFromDetections(sources: DetectedSource[]): SourceConfig {
  const detected = new Set(sources.filter((source) => source.detected).map((source) => source.id));
  if (detected.size === 0) {
    detected.add("claude-code");
  }

  return {
    "claude-code": { enabled: detected.has("claude-code") },
    codex: { enabled: detected.has("codex") },
    hermes: { enabled: detected.has("hermes") },
  };
}

function detectedKeyPlaceholder(provider: string, keys: DetectedApiKeys): string | undefined {
  if (provider === "openai" && keys.openai) return OPENAI_API_KEY_PLACEHOLDER;
  if (provider === "anthropic" && keys.anthropic) return ANTHROPIC_API_KEY_PLACEHOLDER;
  return undefined;
}

function apiKeyPrompt(provider: string, keys: DetectedApiKeys): string {
  const key = provider === "anthropic" ? keys.anthropic : keys.openai;
  if (!key) return "API Key (leave empty to use environment later)";
  return `API Key (detected: ${maskKey(key)} from ${keys.source})`;
}

async function askRequired(
  prompt: Prompt,
  question: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const answer = await prompt.ask(question, defaultValue);
    if (answer) return answer;
    // Input exhausted (piped/non-interactive) with no value for a required field —
    // re-prompting would loop forever, so fail loudly instead.
    if (prompt.isClosed()) {
      throw new Error(`No input provided for required field: ${question}`);
    }
  }
}

function buildAutoConfig(keys: DetectedApiKeys, sources: DetectedSource[]): PartialConfig {
  const provider = keys.openai ? "openai" : "anthropic";
  const model = provider === "openai" ? LLM_MODELS.openai : LLM_MODELS.anthropic;
  const llmApiKey =
    provider === "openai" ? OPENAI_API_KEY_PLACEHOLDER : ANTHROPIC_API_KEY_PLACEHOLDER;
  const useOpenAIEmbedding = Boolean(keys.openai);

  return {
    llm: {
      provider,
      model,
      api_key: llmApiKey,
    },
    sources: sourceConfigFromDetections(sources),
    store: {
      data_dir: "~/.memkin/data",
    },
    embedding: {
      provider: useOpenAIEmbedding ? "openai" : "ollama",
      model: useOpenAIEmbedding ? "text-embedding-3-large" : "nomic-embed-text",
      dimensions: useOpenAIEmbedding ? 1536 : 768,
      ...(useOpenAIEmbedding ? { api_key: OPENAI_API_KEY_PLACEHOLDER } : {}),
      ...(!useOpenAIEmbedding ? { base_url: "http://localhost:11434" } : {}),
    },
    server: {
      http_port: 3927,
      mcp_transport: "stdio",
    },
    scheduler: DEFAULT_SCHEDULER,
  };
}

interface LLMConfigInput {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

async function collectLLMConfig(prompt: Prompt, keys: DetectedApiKeys): Promise<LLMConfigInput> {
  const providerDefault = keys.anthropic && !keys.openai ? 1 : 0;
  const providerChoice = await prompt.select(
    "Select LLM Provider",
    [
      { value: "openai", label: "OpenAI (GPT-4o, etc.)" },
      { value: "anthropic", label: "Anthropic (Claude, etc.)" },
      { value: "openai-compatible", label: "Custom / OpenAI-compatible" },
      { value: "mock", label: "Mock (for testing)" },
    ],
    providerDefault,
  );

  const provider = normalizeProvider(providerChoice);
  const defaultModel =
    providerChoice === "anthropic"
      ? LLM_MODELS.anthropic
      : providerChoice === "mock"
        ? LLM_MODELS.mock
        : LLM_MODELS.openai;
  const model = await askRequired(prompt, "LLM Model", defaultModel);
  const baseUrl =
    providerChoice === "openai-compatible"
      ? await askRequired(prompt, "Base URL")
      : await prompt.ask("Base URL (optional, press Enter to skip)");
  const apiKey =
    providerChoice === "mock"
      ? undefined
      : (await prompt.secret(apiKeyPrompt(provider, keys))) ||
        detectedKeyPlaceholder(provider, keys);

  return { provider, model, baseUrl: baseUrl || undefined, apiKey };
}

async function setupOllama(prompt: Prompt, output: Writable): Promise<void> {
  const MODEL = "nomic-embed-text";

  write(output, "");
  write(output, "--- Ollama Setup ---");

  // Step 1: Check if Ollama is running
  write(output, "  Checking Ollama ...");
  const running = await checkOllamaRunning();

  if (!running) {
    write(output, "  [!!] Ollama is not running.");
    write(output, "");
    write(output, "  Install Ollama:");
    write(output, "    macOS/Linux: curl -fsSL https://ollama.com/install.sh | sh");
    write(output, "    Windows:     https://ollama.com/download");
    write(output, "");
    write(output, "  Then start it: ollama serve");
    write(output, "");

    // Wait for user to start Ollama
    while (true) {
      const retry = await prompt.confirm("Press Y when Ollama is running to continue", true);
      if (!retry) {
        write(output, "  [!!] Skipping Ollama setup. You can run it later.");
        return;
      }
      const ok = await checkOllamaRunning();
      if (ok) {
        write(output, "  [ok] Ollama is running");
        break;
      }
      write(output, "  [xx] Still not reachable. Make sure 'ollama serve' is running.");
      if (prompt.isClosed()) {
        write(output, "  [!!] Skipping Ollama setup (input ended). You can run it later.");
        return;
      }
    }
  } else {
    write(output, "  [ok] Ollama is running");
  }

  // Step 2: Check if model is pulled
  write(output, `  Checking model ${MODEL} ...`);
  const hasModel = await checkOllamaModel(MODEL);

  if (!hasModel) {
    write(output, `  [!!] Model '${MODEL}' not found.`);
    const doPull = await prompt.confirm(`Pull ${MODEL} now? (~274MB)`, true);

    if (doPull) {
      write(output, `  Pulling ${MODEL} ... (this may take a few minutes)`);
      try {
        execSync(`ollama pull ${MODEL}`, { stdio: "inherit" });
        write(output, `  [ok] ${MODEL} ready`);
      } catch {
        write(output, `  [xx] Pull failed. Run manually: ollama pull ${MODEL}`);
      }
    } else {
      write(output, `  [!!] Remember to run: ollama pull ${MODEL}`);
    }
  } else {
    write(output, `  [ok] Model ${MODEL} is ready`);
  }
}

async function buildInteractiveConfig(
  prompt: Prompt,
  output: Writable,
  keys: DetectedApiKeys,
  sources: DetectedSource[],
): Promise<PartialConfig> {
  write(output, "");
  write(output, "--- LLM Configuration ---");

  // Collect LLM config with connection test loop
  let llmCfg: LLMConfigInput;
  while (true) {
    llmCfg = await collectLLMConfig(prompt, keys);

    if (llmCfg.provider === "mock") break;

    write(output, "  Testing connection ...");
    const test = await testLLMConnection(llmCfg);
    if (test.ok) {
      write(output, "  [ok] Connection successful");
      break;
    }

    write(output, `  [xx] ${test.error}`);
    write(output, "");

    // Input exhausted — re-prompting for new settings would loop forever. Proceed with
    // what was entered rather than spinning.
    if (prompt.isClosed()) {
      write(output, "  [!!] Proceeding with the entered settings (input ended).");
      break;
    }
  }

  const { provider: llmProvider, model: llmModel, baseUrl, apiKey } = llmCfg;

  write(output, "");
  write(output, "--- Embedding ---");
  write(output, "  Assessing hardware and data volume ...");

  const assessment = runEmbeddingAssessment(sources);
  const hw = assessment.hardware;
  const data = assessment.dataVolume;

  // Display hardware info
  write(output, `  CPU:    ${hw.cpuModel}`);
  write(output, `  Memory: ${hw.memoryGB}GB`);
  if (hw.hasAppleSilicon) write(output, "  GPU:    Apple Silicon (Metal)");
  else if (hw.hasNvidiaGpu) write(output, `  GPU:    ${hw.gpuName}`);
  else write(output, "  GPU:    None detected");
  write(
    output,
    `  Data:   ${data.jsonlFiles} JSONL files, ~${data.totalSizeMB}MB, ~${data.estimatedChunks} chunks`,
  );
  write(output, "");

  // Show recommendation
  const isOpenAIRecommended = assessment.recommendation === "openai";
  write(output, `  Recommendation: ${isOpenAIRecommended ? "[OpenAI]" : "[Ollama]"}`);
  write(output, `  Reason: ${assessment.reason}`);
  write(output, "");

  const embeddingProvider = await prompt.select(
    "Select Embedding Provider",
    [
      {
        value: "openai",
        label: `OpenAI (text-embedding-3-large)${isOpenAIRecommended ? " ← Recommended" : ""}`,
      },
      {
        value: "ollama",
        label: `Ollama (nomic-embed-text, local)${!isOpenAIRecommended ? " ← Recommended" : ""}`,
      },
    ],
    isOpenAIRecommended ? 0 : 1,
  );

  // Collect embedding-specific config
  let embeddingConfig: NonNullable<PartialConfig["embedding"]>;

  if (embeddingProvider === "ollama") {
    await setupOllama(prompt, output);
    embeddingConfig = {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      base_url: "http://localhost:11434",
    };
  } else {
    // OpenAI embedding — collect base_url + api_key, test connection
    write(output, "");
    write(output, "--- OpenAI Embedding Configuration ---");

    // If LLM already uses OpenAI-compatible key, offer to reuse it
    const llmIsOpenAICompatible = llmProvider === "openai" && apiKey;
    let embeddingBaseUrl: string | undefined;
    let embeddingApiKey: string | undefined;

    const reuseKey = llmIsOpenAICompatible
      ? await prompt.confirm(`Reuse the same API key and base URL from LLM config?`, true)
      : false;

    if (reuseKey && llmIsOpenAICompatible) {
      embeddingBaseUrl = baseUrl || undefined;
      embeddingApiKey = apiKey;
    } else {
      embeddingBaseUrl = await prompt.ask(
        "Embedding Base URL (press Enter for official OpenAI)",
        "https://api.openai.com/v1",
      );
      embeddingApiKey =
        (await prompt.secret("Embedding API Key")) ||
        (keys.openai ? OPENAI_API_KEY_PLACEHOLDER : undefined);
    }

    // Test embedding connection
    write(output, "  Testing embedding connection ...");
    const testOk = await testEmbeddingConnection(
      embeddingBaseUrl ?? "https://api.openai.com/v1",
      embeddingApiKey ?? "",
      "text-embedding-3-large",
    );
    if (testOk.ok) {
      write(output, "  [ok] Embedding connection successful");
    } else {
      write(output, `  [xx] ${testOk.error}`);
      write(output, "  Proceeding anyway — you can fix this in memkin.yaml later.");
    }

    embeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 1536,
      ...(embeddingBaseUrl && embeddingBaseUrl !== "https://api.openai.com/v1"
        ? { base_url: embeddingBaseUrl }
        : {}),
      ...(embeddingApiKey ? { api_key: embeddingApiKey } : {}),
    };
  }

  const configurePrivacy = await prompt.confirm("Configure advanced privacy settings?", false);
  const privacy: PartialConfig["privacy"] = {
    enabled: true,
    mode: "reversible",
    redact_phone: true,
    redact_id_card: true,
    redact_bank_card: true,
    redact_email: false,
    redact_url: false,
    blocked_words: [],
    replacement: "[REDACTED]",
  };

  if (configurePrivacy) {
    write(output, "");
    write(output, "--- Privacy ---");
    privacy.enabled = await prompt.confirm("Enable privacy redaction?", true);
    if (privacy.enabled) {
      privacy.mode = (await prompt.select(
        "Redaction mode",
        [
          { value: "reversible", label: "Reversible" },
          { value: "irreversible", label: "Irreversible" },
        ],
        0,
      )) as "reversible" | "irreversible";
      privacy.redact_phone = await prompt.confirm("Redact phone numbers?", true);
      privacy.redact_id_card = await prompt.confirm("Redact ID cards?", true);
      privacy.redact_bank_card = await prompt.confirm("Redact bank cards?", true);
      privacy.redact_email = await prompt.confirm("Redact emails?", false);
      privacy.redact_url = await prompt.confirm("Redact URLs?", false);
    }
  }

  return {
    llm: {
      provider: llmProvider,
      model: llmModel,
      ...(baseUrl ? { base_url: baseUrl } : {}),
      ...(apiKey ? { api_key: apiKey } : {}),
    },
    sources: sourceConfigFromDetections(sources),
    privacy,
    store: {
      data_dir: "~/.memkin/data",
    },
    embedding: embeddingConfig,
    server: {
      http_port: 3927,
      mcp_transport: "stdio",
    },
    scheduler: DEFAULT_SCHEDULER,
  };
}

function validateOrThrow(config: PartialConfig): void {
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(`Configuration validation failed:\n${validation.errors.join("\n")}`);
  }
}

function saveConfig(configPath: string, yaml: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, yaml, "utf-8");
}

function printDetections(output: Writable, sources: DetectedSource[]): void {
  write(output, "");
  write(output, "--- Data Sources ---");
  for (const source of sources) {
    write(output, `  ${source.detected ? "[ok]" : "[--]"} ${source.name}: ${source.message}`);
  }
}

function printRuntime(output: Writable): void {
  const runtime = detectCurrentRuntime();
  write(output, "");
  write(output, "--- Runtime ---");
  write(output, `  [ok] ${runtime.name} v${runtime.version} detected`);
}

function registerCommand(output: Writable): boolean {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageRoot = resolve(__dirname, "../..");

  // Try npm link first (works cross-platform)
  try {
    execSync("npm link", { stdio: "pipe", cwd: packageRoot });
    write(output, "[ok] `memkin` command registered via npm link");
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err);
    write(output, `[warn] npm link failed: ${reason}`);
    write(output, "[info] Falling back to shell alias...");
  }

  // Fallback: add alias to shell config (POSIX only)
  if (process.platform === "win32") return false;

  // Resolve from this file's location so npx temp-dir runs produce the correct path
  const binPath = resolve(__dirname, "../../bin/memkin.mjs");
  const aliasLine = `alias memkin='node ${binPath}'`;
  const shellFiles = [".zshrc", ".bashrc", ".bash_profile"];

  for (const file of shellFiles) {
    const shellPath = join(homedir(), file);
    if (!existsSync(shellPath)) continue;
    try {
      let content = readFileSync(shellPath, "utf-8");

      // Replace any stale memkin alias (covers both bin/memkin and bin/memkin.mjs variants)
      const stalePattern = /alias memkin=(['"])[^'"]*\1/g;
      if (stalePattern.test(content)) {
        content = content.replace(/alias memkin=(['"])[^'"]*\1/g, aliasLine);
        writeFileSync(shellPath, content, "utf-8");
        write(output, `[ok] Updated stale alias in ~/${file} — run: source ~/${file}`);
        return true;
      }

      // Already correct
      if (content.includes(aliasLine)) return true;

      // Not yet registered
      writeFileSync(shellPath, `${content.trimEnd()}\n\n# Memkin\n${aliasLine}\n`, "utf-8");
      write(output, `[ok] Alias added to ~/${file} — run: source ~/${file}`);
      return true;
    } catch {}
  }

  return false;
}

function printNextSteps(output: Writable): void {
  write(output, "");
  write(output, "--- Next Steps ---");
  write(output, "  memkin extract --source claude-code");
  write(output, "  memkin serve");
  write(output, '  memkin search "your query"');
}

function envDisablesTui(env: NodeJS.ProcessEnv): boolean {
  const value = env.MEMKIN_NO_TUI?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function shouldUseTui(
  options: Pick<InitOptions, "auto" | "tui">,
  input: { isTTY?: boolean },
  output: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.auto) return false;
  if (options.tui === false) return false;
  if (envDisablesTui(env)) return false;
  return input.isTTY === true && output.isTTY === true;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const configPath = getConfigPath(options.configPath);

  const useTui = shouldUseTui(
    options,
    input as { isTTY?: boolean },
    output as { isTTY?: boolean },
    options.env,
  );

  if (useTui) {
    const { runConfigCenter } = await import("../config-center/index.js");
    await runConfigCenter({ configPath, force: options.force, input, output });
    return;
  }

  const nonTty =
    (input as { isTTY?: boolean }).isTTY !== true || (output as { isTTY?: boolean }).isTTY !== true;
  if (!options.auto && options.tui !== false && nonTty) {
    write(output, "[info] Non-interactive mode detected. Using CLI prompts.");
  }

  const prompt = options.auto ? undefined : createPrompt(input, output);

  // Capture before any overwrite logic — genuine new install means the config file doesn't exist yet.
  const isNewInstall = !existsSync(configPath);

  try {
    if (existsSync(configPath) && !options.force) {
      if (options.auto || !prompt) {
        throw new Error(
          `Configuration file already exists: ${configPath}. Use --force to overwrite.`,
        );
      }

      const overwrite = await prompt.confirm(
        `Configuration file already exists: ${configPath}. Overwrite?`,
        false,
      );
      if (!overwrite) {
        write(output, "Init cancelled.");
        return;
      }
    }

    const sources = detectSources();
    const keys = detectApiKeys();

    // Only compute the managed-engine opt on a genuine new install.
    // On --force overwrite, the user has an existing install; we must not silently change their engine.
    const newInstallEngineOpt = isNewInstall
      ? {
          newInstallEngine: resolveDefaultEngineForNewInstall({
            platform: process.platform,
            arch: process.arch,
            home: homedir(),
          }),
        }
      : undefined;

    if (options.auto) {
      if (!keys.openai && !keys.anthropic) {
        throw new Error("No API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
      }
      const config = buildAutoConfig(keys, sources);
      validateOrThrow(config);
      saveConfig(configPath, generateConfigYaml(config, newInstallEngineOpt));
      write(output, `[ok] Configuration saved to: ${configPath}`);
      return;
    }

    if (!prompt) {
      throw new Error("Interactive prompt was not initialized.");
    }

    write(output, "╔════════════════════════════════════════╗");
    write(output, "║      Welcome to Memkin Setup         ║");
    write(output, "╚════════════════════════════════════════╝");
    printRuntime(output);
    printDetections(output, sources);

    const config = await buildInteractiveConfig(prompt, output, keys, sources);
    validateOrThrow(config);

    const yaml = generateConfigYaml(config, newInstallEngineOpt);
    write(output, "");
    write(output, "--- Preview ---");
    write(output, `# memkin.yaml (${yaml.split(/\r?\n/).filter(Boolean).length} lines)`);
    write(output, yaml);

    const confirmed = await prompt.confirm("Save this configuration?", true);
    if (!confirmed) {
      write(output, "Init cancelled.");
      return;
    }

    saveConfig(configPath, yaml);
    write(output, "");
    write(output, `[ok] Configuration saved to: ${configPath}`);

    const legacyPath = resolve(dirname(configPath), "dbe.yaml");
    if (existsSync(legacyPath)) {
      write(output, `[!!] Legacy dbe.yaml detected: ${legacyPath}`);
      write(
        output,
        "      Rename or merge it into memkin.yaml if it contains settings you still need.",
      );
    }

    if (options.registerCommand !== false) {
      // Register memkin command
      write(output, "");
      write(output, "--- Registering memkin command ---");
      const registered = registerCommand(output);
      if (registered) {
        write(output, "[ok] memkin command is ready to use");
      } else {
        write(output, "[!!] Could not register automatically. Run manually:");
        write(output, "      npm link");
      }
    }

    printNextSteps(output);
  } finally {
    prompt?.close();
  }
}
