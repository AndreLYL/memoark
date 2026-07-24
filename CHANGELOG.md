# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Home installs no longer nest state at `~/.memkin/.memkin/`**: `ensureStateDir`/`statePath`
  appended `.memkin` even when the config root already IS `~/.memkin` (the standard home
  install), splitting scheduler state away from `daemon.json`. Worse, the daemon's
  dedup/cursor/redaction-map checkpoints defaulted to `process.cwd()` instead of the config
  root, so a daemon launched with `cwd=/` or `cwd=$HOME` scattered state across up to three
  places. State now resolves through one helper (`stateDirFor`), the serve runtime builds its
  pipeline config via the same factory as `memkin extract`, `memkin docs sync` anchors to the
  config root, and `doctor` checks the corrected path (it used to recompute the nested path
  and bless the bug). On startup, files left in a pre-fix `~/.memkin/.memkin/` are migrated up
  (never overwriting newer files) so existing installs keep scheduler backoff and dedup/cursor
  checkpoints.
- **`memkin status` no longer shows a permanent "⚠ Serving subset changed" false positive**:
  `up` stored the serving-subset hash with a hardcoded `readOnly: false` while `status`
  recomputed it from bare config (`mcp.http.read_only: true` in the default config), so the
  hashes could never converge no matter how often `memkin up` ran. Both sides now derive the
  hash from one helper (`resolveDaemonLaunchRuntime`) that models the daemon exactly as `up`
  launches it (loopback bind, read-write). Stored hashes from older versions match the new
  recompute for default configs, so the warning clears without re-running `up`.
- **`serve` now actually auto-captures the enabled channels after a fresh install**: the
  scheduler treated `scheduler.sources` as the authoritative list of what to run, but every
  config writer (web setup wizard, Auto-fetch settings, CLI `init`) persists that map as
  overrides only — a fresh install saved `{}` (or no scheduler block at all), so the scheduler
  started with zero schedules and never extracted anything. The schedulable set is now derived
  from the enabled data channels (`claude-code`/`codex`/`hermes`, `feishu`, `feishu.docs`),
  with `scheduler.sources` entries kept as per-source overrides (`interval_secs`,
  `enabled: false`). Note for hand-written configs: a `scheduler.sources` map that lists only
  some channels no longer disables the rest — set `enabled: false` per source (or disable the
  channel) to opt out.
- **Toggling Auto-fetch in the running app now takes effect immediately**: a
  `scheduler.enabled` flip forces a runtime rebuild on config reload, so turning it on wires
  and starts the capture loop (and turning it off stops it) without restarting the daemon.
- **CLI `memkin init` now writes the same default scheduler block as the web wizard**
  (auto-fetch on, hourly interval), so CLI-initialized installs auto-capture too.

## [0.4.2] - 2026-07-07

### Fixed

- **`npx memkin` / global install no longer crashes with `Cannot find package 'fast-glob'`**:
  `fast-glob` is imported by runtime code (`collectors/agent/collector.ts`,
  `core/agent-session-scanner.ts`) but was declared under `devDependencies`, so a clean install
  (which omits dev dependencies) shipped without it. Moved to `dependencies`. This latent packaging
  bug predates 0.4.1; it surfaced on any command that loads the agent collector (the release
  `--help` smoke test never imported that path).

## [0.4.1] - 2026-07-07

Post-rename hardening + launch polish. Data-integrity and collector fixes, a self-healing
upgrade path for daemons carried over from the rename, a demo dataset with a recorded GIF,
and a rewritten README.

### Added

- Synthetic demo dataset (`demo/seed/`) and a one-command seed script (`scripts/demo-seed.ts`)
  that populates an isolated demo library, plus an offline, deterministic recall renderer
  (`demo/demo-query.ts`) and a VHS tape (`demo/demo.tape`) used to record `docs/assets/demo.gif`.
- Entity normalization and provenance backfill for extraction quality, an agent session ledger,
  and an evaluation harness for measuring extraction quality (extraction-quality-redesign PR-0/1/3).

### Fixed

- **A write that fails on disk no longer reports phantom success/failure**: `rowToPage` returns
  ISO-string timestamps per the `Page` contract, so MCP write tools (e.g. `put_page`) no longer
  land on disk while failing output-schema validation — agent clients previously saw an error on a
  write that had actually succeeded and could retry it.
- **Read-only commands no longer blocked by an embedding fingerprint mismatch**: `EmbeddingService`
  is now constructed lazily, so FTS `search` and `export` run without an embedding provider or API
  key even when the stored fingerprint differs from config; the mismatch error now spells out both
  recovery paths (revert config, or clear vectors + re-embed).
- **Daemons survive the memoark→memkin rename**: startup now migrates and self-heals the
  `config_path` persisted in `daemon.json` (missed by the initial rename migration), and a
  daemon-launched serve that reads a stale path falls back to normal config discovery and writes
  the corrected path back.
- **Feishu calendar events are no longer dropped past the first page**: the calendar source now
  paginates through `page_token`.
- **A single malformed JSONL line no longer aborts an agent-collection run**: bad or non-object
  lines are skipped and counted as warnings instead of failing the whole run.
- **Timeline feed pagination** now treats the cursor as an upper bound so pages don't repeat or
  skip, and **the scheduler enforces a per-source timeout** (`scheduler.source_timeout_ms`) so one
  wedged source can't stall the whole scheduler.
- Middle-band (0.15–0.85) blocks from the significance score gate now get a final L2 LLM
  significance judgment instead of being admitted unconditionally — the single largest source of
  extracted noise.

### Changed

- README (both 中文 and English) rewritten for launch: new hero (banner, tagline, demo GIF),
  a 30-second quick start, a Claude Code / Codex-only path for users without Feishu, and factual
  corrections (default MCP tool count, memory consolidation naming, source list).

## [0.4.0] - 2026-07-06

### Changed

- **Renamed the product from `memoark` to `memkin`** (trademark/SEO collision). The npm package moves from `@andre.li/memoark` to `memkin`, the config file `memoark.yaml` becomes `memkin.yaml`, and the data/state directories `~/.memoark` / `.memoark/` become `~/.memkin` / `.memkin/`. Automatic migration is included in this release: on first run the CLI renames `~/.memoark`, `memoark.yaml` (found via the same parent-directory walk as config discovery), and `.memoark/` to their memkin equivalents. If both the old and new path exist, the new one is kept and a warning flags the stale legacy path (nothing is merged or deleted); if the rename fails — e.g. old and new on different volumes — nothing is copied and an actionable manual `mv` hint is printed. Legacy `MEMOARK_*` environment variables are no longer read; a startup warning lists any still set with their `MEMKIN_*` replacements.

### Added

- SourceRef v2 core and extension fields with schema parity, compact provenance handling, participant metadata, and cross-source source type support.
- Unified MemoryFilter support for MCP `query`, `search`, and `timeline_feed`, including platform, source type, channel, participant, date, type, exclude type, and bounded limit filters.
- Preferred MCP memory tools: `get_page_context`, `timeline_feed`, `explore_graph`, `manage_links`, and `manage_tags`.
- MCP contract tests using the SDK in-memory client transport to verify tool listing, tool descriptions, package version alignment, legacy tool gating, and structured errors.
- MCP Resources for `memkin://health`, `memkin://pages`, page content, page context, and page timeline.
- MCP Prompts for recall, weekly digest, person brief, decision log, and project handoff workflows.
- Structured MCP tool output schemas and `structuredContent` for core read/health tools while preserving stable JSON text responses.
- Streamable HTTP MCP app with origin, host, bearer-token, and read-only tool gating.
- MCP eval fixtures and a contract eval runner covering tool selection constraints, source-specific tool bans, read-only mode, and source-filtered timeline behavior.

### Changed

- MCP tools now register with titles, descriptions, parameter descriptions, stable JSON text responses, recoverable structured errors, and package-version server metadata.
- MCP legacy CRUD/debug tools are hidden by default and can be exposed with `mcp.expose_legacy_tools=true`.
- `put_page` now performs idempotent writes and skips rechunking when content is unchanged.
- Search results now include provenance when page frontmatter contains `source` or `first_seen`.
- Timeline and graph upserts now keep latest provenance/source hash when new provenance is provided, while preserving existing provenance for provenance-less updates.
- Date-only `to` filters now cover the full day, while datetime `to` filters use the exact timestamp bound.
- Hybrid query chunk searches now use parameterized candidate limits instead of hard-coded SQL limits.
- `memkin serve` can run MCP Streamable HTTP via `--mcp-http`, `mcp.http.enabled`, or `server.mcp_transport=streamable_http`; stdio remains the default MCP path.

### Fixed

- Configuration discovery now resolves `memkin.yaml` from `--config`, `MEMKIN_CONFIG`, or parent directories, and state files now anchor to the resolved config root to avoid cross-directory cursor/dedup splits.
- Missing environment variables referenced by `${VAR}` placeholders are preserved and reported per command instead of being silently replaced with empty strings.
- The CLI binary now falls back to the current Node runtime when Bun is unavailable, while `memkin serve` can run through `@hono/node-server`.
- Runtime resource loading for schema and prompt files now reports explicit build asset errors when packaged files are missing.
- Setup command registration now reports `npm link` failures before falling back to a shell alias.
- Store writes for timeline entries, graph links, and tags now fail when target page slugs are missing instead of silently reporting success after zero-row inserts.
- Preferred MCP tools now all declare output schemas, and write tools return structured content on successful calls.
- MCP write tools now validate incoming provenance objects and return recoverable `INVALID_ARGUMENT` errors for invalid SourceRef input.
- MCP Streamable HTTP transport connection failures now return structured JSON errors instead of escaping as raw exceptions.

## [0.3.1] - 2026-06-10

### Changed

- Published under the scoped name **`@andre.li/memoark`** — npm blocks the unscoped `memoark` as too similar to the existing `remark` package. Install with `npx @andre.li/memoark` / `npm i -g @andre.li/memoark`; the command is still `memoark`. (0.3.0 was never published.)

## [0.3.0] - 2026-06-09

### Added

- **npm distribution**: published to npm — install with `npx memoark` or `npm i -g memoark` (no clone/`npm link` needed). Requires Node.js >= 18.
- **Automated releases**: `.github/workflows/release.yml` publishes to npm (with provenance) and creates a GitHub Release on a `v*` tag; includes a `node dist/cli.js --help` smoke gate. See `RELEASING.md`.

### Fixed

- **Packaging**: the built `dist/` (and a future `bun --compile` binary) now run on plain Node. Migrations are inlined as constants instead of read from `.sql` files that were never shipped (fixed `ENOENT 001_lifecycle_columns.sql`), and 14 relative imports got explicit `.js` extensions (fixed `ERR_MODULE_NOT_FOUND` under Node ESM). The previously failing `cli.test` now passes.

## [0.2.0] - 2026-05-26

### Added

- **Storage Layer**: PGLite embedded PostgreSQL with pgvector for local-first storage
  - PageStore: Wiki-style pages with YAML frontmatter, CRUD, content hashing
  - ChunkStore: Recursive text chunking (300 words, 50-word overlap) with embedding reuse
  - SearchEngine: Full-text search (`tsvector` with `simple` tokenizer) + vector cosine search
  - Hybrid Search: Reciprocal Rank Fusion (RRF) combining FTS + vector results, compiled_truth boost (2.0x), backlink boost
  - GraphStore: Directed link graph with BFS traversal, link types, backlinks
  - TagStore: Page tagging with conflict-safe upserts
  - TimelineStore: Chronological entries per page with dedup
  - EmbeddingService: Batch embedding via OpenAI or Ollama, stale-chunk detection
- **Server**: Hono REST API exposing all store operations
- **MCP Server**: 17 stdio tools for pages, search, graph, tags, timeline, embeddings, and health
- **StoreAdapter**: Extraction pipeline writes signals directly to PGLite (replaces file-based output)
- **CLI Commands**: `memoark serve` (HTTP + MCP), `memoark search`, `memoark embed`
- **Config**: Store, embedding, and server configuration sections with env var interpolation
- Knowledge signal type (7th signal type): reusable facts with provenance and confidence

### Changed

- Renamed CLI from `dbe` to `memoark`
- Default adapter changed from `stdout` to `store`
- Package description updated to "Local-first personal memory extraction and storage"

## [0.1.0] - 2026-05-18

### Added

- Core extraction pipeline: Collector → BlockBuilder → NoiseFilter → SignalExtractor → Privacy → Formatter → Adapter
- Three platform collectors: Claude Code, Codex, Hermes
- Six signal types: entities, timeline, decisions, tasks, discoveries, links
- LLM-powered noise filtering (L1 rules + L2 LLM scoring)
- LLM-powered signal extraction with structured JSON output
- Privacy processor with reversible and irreversible redaction modes
- JSON and Markdown output formatters
- File, GBrain, and Stdout output adapters
- CLI with `extract`, `doctor`, `config init`, `sources list`, `sources test` commands
- Dedup store for message deduplication
- Configuration via `dbe.yaml` with environment variable interpolation
- 252 tests covering core components, pipeline integration, CLI, and golden output
- Apache 2.0 license
- English and Chinese documentation
