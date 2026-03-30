# Changelog

## [2.17.4] - 2026-03-30

### Bug Fixes
- **All MCP configs now use absolute paths** — Copilot CLI 1.0.13 auto-discovers `.vscode/mcp.json` but cannot resolve `${workspaceFolder}` variables, causing `Connection closed`. All generated MCP configs (`.vscode/mcp.json`, `.copilot/mcp-config.json`, `.mcp.json`) now use absolute paths for `command`, `args`, and `env` values. These files are gitignored so absolute paths don't affect other users.

## [2.17.3] - 2026-03-30

### Bug Fixes
- **Reverted `--disable-mcp-server` in `optimus go`** — The v2.17.2 fix caused `spartan-swarm` to show as disabled (⊘) because `--disable-mcp-server` takes precedence over `--additional-mcp-config`. Reverted to simple `--additional-mcp-config` injection, which per Copilot CLI docs "overrides any installed MCP server configuration with the same name."

## [2.17.2] - 2026-03-30

### Bug Fixes
- **MCP duplicate registration via IDE auto-connect** — `optimus go` now passes `--disable-mcp-server` for each server defined in `.copilot/mcp-config.json` before re-injecting via `--additional-mcp-config`. This prevents duplicate `spartan-swarm` registration when Copilot CLI auto-connects to a running VS Code instance that already loaded `.vscode/mcp.json`.

## [2.17.1] - 2026-03-30

### Bug Fixes
- **MCP config `node` ENOENT on Windows** — `optimus init/upgrade` now writes the absolute Node.js path (via `process.execPath`) into generated MCP configs instead of bare `node`. Fixes `spawn node ENOENT` when MCP hosts like Copilot CLI spawn the server without `shell: true`. Fixes #533.

## [2.17.0] - 2026-03-30

### Features
- **`optimus_status` MCP tool** — New tool to verify Optimus Swarm activation. Returns version, workspace, skills/roles/engines count, system instructions and memory status. Provides actionable next steps.
- **Enhanced system instructions (v3)** — Injected `copilot-instructions.md`, `CLAUDE.md`, and `cursor.mdc` now include a MANDATORY FIRST ACTION directing agents to call `optimus_status` immediately, ensuring reliable Optimus activation across all clients.

### Bug Fixes
- **Security: 8 npm vulnerabilities resolved** — Fixed path-to-regexp ReDoS (high), hono prototype pollution, brace-expansion hang, and esbuild/vite/vitest chain (5 moderate). `npm audit` now reports 0 vulnerabilities.
- **Council capacity test fixed** — The pre-existing `council-capacity.test.ts` failure ("rejects malformed config entries") is now resolved. Added `readRawEngineEntries()` fallback for lenient config reading when strict parsing rejects malformed entries. **245/245 tests now pass.**
- **Meta-cron patrol concurrency (#511)** — Fixed safety timer leak in `meta-cron-engine.ts` that allowed overlapping patrol runs. All exit paths now properly clear both `checkInterval` and `safetyTimer`.
- **Agent output_path enforcement (#382)** — Added post-execution artifact rescue in `worker-spawner.ts` that detects when agents write to self-chosen filenames instead of the specified `output_path`, and auto-corrects by moving the content.

### Refactoring
- **worker-spawner.ts modularization** — Extracted 989 lines (37% reduction) into two new modules:
  - `src/mcp/engine-resolver.ts` (1023 lines) — engine config, model validation, protocol resolution, health tracking, ACP auto-discovery
  - `src/mcp/t3-tracker.ts` (80 lines) — T3 usage tracking, role name sanitization, usage log persistence
  - All functions re-exported from `worker-spawner.ts` for backward compatibility

### Dependencies
- vitest upgraded from 2.1.9 to 3.2.4

## [2.16.28] - 2026-03-28

### Features
- **Agent Runtime streaming (SSE)** — New `GET /api/v1/agent/runs/:id/stream` endpoint provides real-time Server-Sent Events during agent execution. Emits `text`, `thinking`, `status`, `error`, and `done` event types with sequence numbers for reconnection support.
- **Streaming pipeline** — `executePrompt()` now accepts an `onChunk` callback that receives streaming chunks from ACP adapters. Events flow from engine → AcpAdapter → genericExecutor → worker-spawner → in-memory event buffer → HTTP SSE.
- **SDK streaming** — `OptimusRuntime` client gains `streamRun()` async generator and `runAndStream()` convenience method for consuming SSE events from TypeScript/JavaScript.
- **Event buffer** — Per-run in-memory ring buffer (2000 events) with subscriber notification, sequence-based replay for reconnection, and automatic TTL cleanup (5 min after completion).

## [2.16.27] - 2026-03-28

### Bug Fixes
- **Agent Runtime state file lifecycle sync** — `worker-spawner` now appends `running`, `completed`, and `failed` history entries to `.optimus/state/agent-runtime/run_*.json` during task execution. Previously, state files remained stuck at `pending` even after successful completion. Fixes #532.

## [2.16.26] - 2026-03-28

### Bug Fixes
- **Runtime `frontmatter` ReferenceError** — Fixed bare `frontmatter` identifier in `worker-spawner.ts` that caused `ReferenceError: frontmatter is not defined` in orchestrator code paths. The variable is now properly scoped as `roleFrontmatter` from the parsed role template. Fixes #531.
- **TypeScript baseline errors resolved** — Fixed `outputSchema` type mismatch in `genericExecutor.ts`. `npm run check-types` now passes with zero errors.

## [2.16.25] - 2026-03-27

### Bug Fixes
- **`optimus go` default `--resume`** — Restored `--resume` as a default argument for both Copilot and Claude adapters, which was accidentally dropped during the multi-CLI refactor in v2.16.24.

## [2.16.24] - 2026-03-27

### Features
- **Multi-CLI `optimus go`** — `optimus go` now supports both GitHub Copilot CLI and Claude Code CLI via a client adapter layer. Use `--cli copilot` or `--cli claude` to override per-launch.
- **Per-project CLI preference** — Each project can store a `preferredCli` in `~/.optimus/projects.json`. Set via `optimus go set-cli <project> <client>`.
- **Global default CLI** — Set via `optimus go set-default-cli <client>`. Resolution order: `--cli` flag → project `preferredCli` → global default → `copilot`.
- **Client adapter architecture** — New `go-clients.js` module provides extensible adapter definitions for each supported CLI (executable, config path, injection flags).

## [2.16.23] - 2026-03-26

### Features
- **Lightweight CLI installer** — New `scripts/install-cli.ps1` and `scripts/install-cli-remote.ps1` install only the `optimus go` launcher (~25KB) to `~/.optimus/cli/`, auto-adding to user PATH. No roles, agents, skills, or dist bundles needed.
  - One-line remote install: `irm https://raw.githubusercontent.com/cloga/optimus-code/master/scripts/install-cli-remote.ps1 | iex`
  - Local install: `.\scripts\install-cli.ps1`
  - Uninstall: `.\scripts\install-cli.ps1 -Uninstall`
- **`optimus go --resume` by default** — `optimus go` now automatically passes `--resume` to Copilot CLI, enabling session resumption without manual flags.

## [2.16.22] - 2026-03-26

### Maintenance
- **Removed redundant dependencies** — Cleaned up 4 unused packages from `package.json`:
  - `lucide-react` (frontend icon library, never imported in CLI codebase)
  - `node-fetch` (no code references; Node 18+ has native `fetch`)
  - `@types/marked` (for marked v5; project uses v17 which ships its own types)
  - `@types/strip-ansi` (for strip-ansi v3; project uses v7 which ships its own types)

## [2.16.21] - 2026-03-26

### Features
- **`optimus go` cross-project Copilot launcher** — Added a new `optimus go` command that launches GitHub Copilot CLI for any registered Optimus workspace without requiring a manual `cd`.
- **Global project registry** — Optimus now stores registered workspaces in `~/.optimus/projects.json`, supports alias-aware project lookup, and can scan the home directory plus its direct child folders for `.optimus/` workspaces.
- **Automatic workspace registration** — `optimus init` and `optimus upgrade` now auto-register the current project in the global registry so it is immediately available to `optimus go`.
- **Regression coverage for project registry** — Added tests covering project registration, scan behavior, and Copilot launcher argument construction.

## [2.16.20] - 2026-03-25

### Bug Fixes
- **Azure DevOps `az-cli` auth support** — `AdoProvider` now respects `ado.auth` from `.optimus/config/vcs.json`. When configured as `\"az-cli\"`, Optimus falls back to `az account get-access-token` if no PAT environment variable is present.
- **ADO authorization header handling** — PAT-based auth continues to use `Basic`, while Azure CLI access tokens now use the correct `Bearer` authorization header.
- **ADO auth regression coverage** — Added tests to verify `az-cli` fallback works and that PAT environment variables still take precedence when present.

## [2.16.19] - 2026-03-25

### Improvements
- **Copilot CLI launcher generation** — `optimus init` and `optimus upgrade` now generate repo-local Copilot CLI launchers (`copilot-optimus.ps1`, `copilot-optimus.cmd`, and `copilot-optimus`) that automatically preload the project's `.copilot/mcp-config.json`.
- **Copilot CLI documentation** — Updated the setup guide to explain that Copilot CLI should be started via the generated launcher so project-level MCP configuration is applied consistently.

## [2.16.18] - 2026-03-22

### Refactoring
- **Architecture: Runtime Decoupling** — `delegateTaskSingle()` now calls `genericExecutor.executePrompt()` instead of directly invoking `AcpAdapter`. This establishes the correct layering: AcpAdapter → genericExecutor (infra) → Harness → Optimus Orchestration (business) → Transport (MCP/HTTP).
  - Output validation runs once inside `executePrompt()` (previously duplicated in both worker-spawner and genericExecutor)
  - Session ID, usage metrics, and stop reason are returned via `ExecuteResult` instead of reading adapter properties directly
  - Doom loop detection and metadata backfill now use `execResult` properties instead of `adapter.lastSessionId`/`adapter.lastUsageLog`/`adapter.lastStopReason`
  - No behavioral changes — all 219/220 tests pass (1 pre-existing failure)

## [2.16.17] - 2026-03-22

### Features
- **Harness Engineering: Mechanical Linter** — Deterministic (non-LLM) validation of Optimus artifacts. Lints role templates (frontmatter fields, naming, engine/model validity, thin template detection), skill files (structure, naming), artifact outputs (type/status/author/date format), and engine-model cross-consistency against `available-agents.json`. Includes `lintWorkspace()` for batch validation.
- **Harness Engineering: Entropy Patrol** — Periodic workspace health checks designed for meta-cron execution. 5 built-in checks: structural lint (roles + skills), stale T1 agent detection (>7 days), orphaned skill references, quarantined role alerts, and memory file health. Generates formatted markdown reports.

## [2.16.16] - 2026-03-22

### Features
- **Harness Engineering: Output Validation Gate** — Agent output is now validated before being written to artifact files. Built-in rules catch: empty output, schema non-compliance, premature completion declarations, unfinished code markers (TODO/FIXME), and error trace leaks. Validation runs on both v1 (delegate_task) and v2 (generic API) paths.
- **Harness Engineering: Doom Loop Detection** — Tracks per-session file edit counts. When an agent edits the same file 3+ times, a warning is logged suggesting the agent reconsider its approach. Inspired by LangChain's LoopDetectionMiddleware.
- **Harness Engineering: Self-Verification Prompt** — All delegated agents now receive a mandatory verification checklist appended to their prompt, requiring them to re-read the task spec, verify output completeness, and check for errors before submitting. Controllable via `verification_level` in role frontmatter (`strict` | `normal` | `skip`).

## [2.16.15] - 2026-03-22

### Features
- **Generic Agent Runtime v2 API** — New decoupled API layer (`/api/v2/`) that provides prompt-based agent execution without Optimus-specific concepts (no role, skill, workspace, or tier system required).
  - `POST /api/v2/agent/run` — Synchronous prompt → result execution
  - `POST /api/v2/agent/start` — Async run initiation
  - `GET /api/v2/agent/runs/:id` — Status polling with result
  - `POST /api/v2/agent/runs/:id/cancel` — Run cancellation
  - `GET /api/v2/health` — Health check with available engines list
- **Built-in engine defaults** — `github-copilot` and `claude-code` engines work out-of-the-box without `available-agents.json` configuration.
- **Structured output via v2** — Pass `output_schema` (JSON Schema) to get validated structured responses.
- **Generic executor** (`genericExecutor.ts`) — Direct AcpProcessPool-based execution, no TaskManifestManager dependency.
- **Generic runtime service** (`genericRuntime.ts`) — In-memory run tracking with lightweight envelope format.

## [2.16.14] - 2026-03-22

### Bug Fixes
- **Artifact file normalization** — When structured output is extracted from prose/markdown wrapping, the clean JSON is now written back to the `output_path` artifact file. This ensures downstream consumers reading the file directly get machine-readable JSON, consistent with the API `result` field.

## [2.16.13] - 2026-03-22

### Features
- **Runtime envelope metadata** — `runtime_metadata` now includes `usage` (token counts: `input_tokens`, `output_tokens`) and `stop_reason` (why the engine stopped, e.g. `end_turn`, `max_tokens`). Captured from ACP `promptResult` for both Copilot and Claude Code engines.
- **ACP structured output preference** — ACP adapter now prefers `promptResult.content` (structured response) over streaming `agent_message_chunk` chunks. Falls back to streaming when engines don't populate content (current behavior for both Copilot and Claude Code).

## [2.16.12] - 2026-03-22

### Bug Fixes
- **Structured output JSON extraction** — When engines return JSON wrapped in markdown prose/code fences, Optimus now extracts the JSON payload before validation. Supports `` ```json ``` `` code fences and brace-matching extraction. Previously this caused `invalid_structured_output` errors even when the engine produced correct JSON.
- **100% agent-friendly error coverage** — All remaining error paths now include actionable `Fix:` guidance:
  - Worker-spawner: engine resolution failure and model pre-flight errors
  - ACP adapter: generic fallback error now suggests recovery steps
- **System defaults skip verbose configs** — `applyEngineDefaults()` now detects old-format configs (with explicit `protocol`, `cli`, or `capabilities` fields) and skips default injection to avoid conflicts.

## [2.16.11] - 2026-03-22

### Bug Fixes
- **CAPIError detection** — Copilot backend API errors (`CAPIError: 400/500`) now caught by fail-fast error detection in worker-spawner and classified with actionable fix guidance in HTTP runtime.
- **Automation policy fix hint** — `buildAutomationCompatibilityFixHint` no longer incorrectly suggests downgrading to `continuation: "single"` for `claude-code`. Now recommends running `upgrade` to refresh system defaults.
- **New HTTP error category** — `automation_policy_invalid` (422) with guidance to run `upgrade` to get system defaults.

## [2.16.10] - 2026-03-22

### Improvements
- **Simplified `available-agents.json`** — Config now only contains `available_models`, `acp.path`, and `timeout`. ACP protocol, warm pool, and autopilot mode are injected as system defaults by `applyEngineDefaults()` in code — no need for users to configure them.
- Engine system defaults are defined per-engine in `ENGINE_SYSTEM_DEFAULTS` (worker-spawner.ts) and deep-merged at config load time.

## [2.16.9] - 2026-03-22

### Features
- **HTTP runtime auto-scaling** — When the primary instance reaches max concurrent runs, overflow instances are automatically spawned on adjacent ports. Overflow instances auto-shutdown after idle timeout (default: 60s). Total capacity = `MAX_CONCURRENT * (1 + MAX_OVERFLOW)` = 20 by default.
  - `OPTIMUS_MAX_OVERFLOW` env var controls max overflow instances (default: 3)
  - `OPTIMUS_OVERFLOW_IDLE_TIMEOUT` env var controls idle shutdown in seconds (default: 60)
  - Primary instance acts as reverse proxy, routing overflow requests transparently
  - `/api/v1/health` reports all instances with per-instance `active_runs` and `idle_ms`
  - `X-Optimus-Instance` response header identifies which instance handled the request

## [2.16.8] - 2026-03-22

### Breaking Changes
- **ACP-only mode** — All engines (`github-copilot`, `claude-code`, `qwen-code`) now use `protocol: "acp"` exclusively. CLI adapters (`GitHubCopilotAdapter`, `ClaudeCodeAdapter`) are deprecated and emit a warning if triggered. All agent interactions go through ACP warm pool with autopilot mode.

### Features
- **HTTP timeout protection** — `server.requestTimeout = 0` to prevent Node.js from killing long-running agent connections (default was 5 min, agent tasks can run 10-30 min).
- **Concurrency control** — `MAX_CONCURRENT_RUNS = 5` (configurable via `OPTIMUS_MAX_CONCURRENT` env var). Returns `429 concurrency_limit` with actionable fix when at capacity.
- **Health endpoint enhanced** — `/api/v1/health` now reports `active_runs` and `max_concurrent` for observability.

## [2.16.7] - 2026-03-22

### Improvements
- **Actionable HTTP runtime errors** — Every error response now includes a `fix` field with concrete recovery steps. Error JSON format: `{ error: { code, message, fix } }`. Covers all 15+ error codes across input validation, run lifecycle, engine errors, and route matching.
- **`invalid_state` now shows actual status** — Resume errors include `current status: <status>` so callers know why the operation was rejected.
- **3 new error classifications** — `role_quarantined`, `skill_preflight_failed`, `engine_resolution_failed` are now properly classified at the HTTP layer instead of falling through to generic `internal_error`.

## [2.16.6] - 2026-03-22

### Features
- **ACP autopilot mode & model selection** — ACP adapter now sends `configOptions` (mode + model) via `session/new`, attempts `session/configure` and `session/setConfiguration` with graceful fallback. Ensures delegated tasks run in autopilot mode when available.
- **AgentAdapter options interface** — `invoke()` accepts optional `{ model, autopilot, maxContinues }` to control session behavior per-task.

## [2.16.5] - 2026-03-22

### Improvements
- **Agent-friendly error messages** — All ACP adapter errors now include recovery guidance (auth setup, retry hints, timeout config). HTTP server errors return structured `error_code` values (`auth_failed`, `rate_limit`, `task_timeout`, `acp_process_crashed`, `invalid_model`, `invalid_engine`, `workspace_not_initialized`) instead of generic `internal_error`.
- **Runtime integration SKILL.md** — Added comprehensive error code reference table, authentication setup guide, warm pool behavior docs, and troubleshooting section for common failures.

### Error Classification (New)
- `auth_failed` (401) — engine authentication missing or expired
- `rate_limit` (429) — API rate limit exceeded
- `task_timeout` (504) — no activity from engine within timeout window
- `acp_process_crashed` (500) — engine process exited unexpectedly (auto-recovers)
- `invalid_model` (400) — model not available for the specified engine
- `invalid_engine` (400) — engine not found in config
- `workspace_not_initialized` (400) — .optimus/ directory not found
- `body_too_large` (413) — now includes 10 MB limit in message
- `invalid_json` (400) — now includes parse error details

## [2.16.4] - 2026-03-22

### Fixes
- **ACP session/prompt uses array format first** — Copilot ACP requires `prompt: [{type:'text', text:...}]` (not `text` string). Swapped compatibility order: try content-array first, fallback to text for legacy agents.
- **`isInvalidParamsError` matches -32603** — Copilot returns `-32603` (Internal error) with schema validation data instead of `-32602` (Invalid params). Error matcher now covers both codes.

### Verified
- HTTP runtime E2E: 4 consecutive tasks via `POST /api/v1/agent/run`
- Warm pool reuse confirmed across all tasks (invocations 1→2→3→4)
- Models tested: `gpt-5.4`, `claude-opus-4.6-1m`, `gemini-3-pro-preview`
- All via Copilot ACP with warm pool — single process, multiple sessions

## [2.16.3] - 2026-03-22

### Fixes
- **Resolver fails for explicit protocol with sub-object capabilities (#499)** — `getTransportConfig()` returned the parent engine config instead of the protocol sub-object when `protocol !== 'auto'`, making `capabilities.automation_continuations` invisible to all check functions. Now prefers the `cli` or `acp` sub-object when it exists.
- **Upgrade merge preserves stale `protocol` field** — `deepMergePreserveUser` treats scalars as atomic, so user's old `protocol: "cli"` overrode template's `"auto"`. Post-merge migration now normalizes `protocol` to `"auto"` when both `acp` and `cli` sub-objects are present.
- **Health endpoint hardcoded version `2.14.0`** — Now injected at build time via esbuild `define` from `package.json`. Health correctly reports the installed version.
- **Stale dist bundles in git** — Rebuilt and committed all 3 bundles so `npx github:cloga/optimus-code#v2.16.3` gets current code.

### Tests
- 4 new regression tests for #499: explicit protocol with sub-objects, explain output verification, flat config backward compatibility.

## [2.16.2] - 2026-03-22

### Fixes
- **Copilot autopilot resolver failure after upgrade** — `deepMergePreserveUser` treated arrays atomically, so users upgrading from older configs had stale `automation_continuations: ["single"]` that suppressed the template's `["single", "autopilot"]`. Both ACP and CLI transports failed the continuation check, causing `selectedProtocol = null` and timeout-like behavior. (Fixes #499)
- **Scaffold ACP config stale** — Updated scaffold `available-agents.json` so new installs get correct Copilot ACP capabilities (`autopilot` in continuations, no `--stdio` flag).
- **Upgrade now unions capability arrays** — Post-merge migration ensures engine capability arrays are unioned with template values instead of being overridden by old user arrays. Also strips stale `--stdio` from ACP args.

## [2.16.1] - 2026-03-22

### Fixes
- **init/upgrade now copies all 3 dist bundles** — Previously only `mcp-server.js` was copied to `.optimus/dist/`, making `http-runtime.js` and `runtime-cli.js` unavailable in user workspaces. Now all 3 bundles are deployed on `optimus init` and `optimus upgrade`.

### Additions
- **runtime-integration skill** — Agent-discoverable documentation for HTTP REST, TypeScript SDK, and CLI contract integration. Agents find it via `list_knowledge()` or `.optimus/skills/` scan.

## [2.16.0] - 2026-03-22

### Features
- **Copilot CLI ACP Warm Pool** — GitHub Copilot now runs via ACP protocol (`copilot --acp`) with persistent process pooling. Every delegation reuses a warm Copilot process instead of spawning fresh `copilot -p "prompt"` subprocesses (~4s cold start eliminated).
- **Agent Runtime In-Process Execution** — HTTP server, CLI, and SDK now execute tasks in-process, sharing the warm `AcpProcessPool` across runs. Previously each API call spawned a detached subprocess with its own pool (no warm reuse).
- **Unified Warm Pool** — All transports (MCP `delegate_task`, HTTP `/agent/run`, CLI `optimus-runtime run`, SDK `runtime.runAgent()`) now share the same `AcpProcessPool` for both Claude and Copilot engines.

### Changes
- Copilot ACP capabilities updated to declare `autopilot` support — ACP protocol inherently supports continuation (agent runs to completion within `session/prompt`).
- Protocol auto-resolution now correctly selects ACP (preferred) for Copilot instead of falling back to CLI.
- Removed 5 Agent Runtime MCP tools (`run_agent`, `start_agent_run`, `get_agent_run_status`, `resume_agent_run`, `cancel_agent_run`) — replaced by native HTTP/CLI/SDK transports from v2.15.0.
- Added `runWorkerInProcess()` in council-runner — process-safe variant that never calls `process.exit()`.
- Removed redundant `--stdio` flag from Copilot ACP args.

## [2.15.1] - 2026-03-22

### Features
- **Copilot CLI ACP Warm Pool** — GitHub Copilot now runs via ACP protocol (`copilot --acp`) with persistent process pooling, matching the warm start optimization previously available only for Claude ACP.
  - **Before**: Every delegation spawned a fresh `copilot -p "prompt"` process (~4s cold start: Node.js bootstrap + MCP server init + tool registration)
  - **After**: A persistent `copilot --acp` process stays alive in the pool; subsequent tasks skip all initialization overhead
  - Verified: `copilot --acp` implements full ACP JSON-RPC protocol (initialize, session/new, session/prompt, session/update streaming, session/request_permission auto-approval)
  - Session context preserved across multi-turn interactions within the same warm process

### Changes
- **`available-agents.json`** — Copilot ACP capabilities updated to declare `autopilot` support in `automation_continuations`. ACP protocol inherently supports continuation (agent runs to completion within `session/prompt`), so `autopilot` is a natural fit.
- **Protocol resolution** now correctly selects ACP (preferred) for Copilot instead of falling back to CLI. Previous behavior was caused by ACP not declaring `autopilot` capability while the engine automation requested it.
- Removed redundant `--stdio` flag from Copilot ACP args (Copilot `--acp` defaults to stdio transport).

## [2.15.0] - 2026-03-22

### Features
- **Agent Runtime HTTP Server** — Native REST API for host application integration, no MCP transport required:
  - `POST /api/v1/agent/run` — Synchronous run (blocks until complete)
  - `POST /api/v1/agent/start` — Async start (returns immediately)
  - `GET /api/v1/agent/runs/:id` — Get run status/result
  - `POST /api/v1/agent/runs/:id/resume` — Resume blocked run
  - `POST /api/v1/agent/runs/:id/cancel` — Cancel active run
  - `GET /api/v1/health` — Health check
  - Start: `node .optimus/dist/http-runtime.js --port 3100 --workspace /path`
- **Agent Runtime CLI Contract** — JSON-in/JSON-out CLI for app embedding:
  - `optimus-runtime run < request.json` — sync run
  - `optimus-runtime start < request.json` — async start
  - `optimus-runtime status --run-id <id>` — get status
  - `optimus-runtime resume < resume.json` — resume blocked
  - `optimus-runtime cancel --run-id <id>` — cancel
  - All output is structured JSON on stdout, logs on stderr
- **TypeScript SDK** (`src/sdk/runtime-client.ts`) — Thin HTTP client wrapping the REST API:
  - `const runtime = new OptimusRuntime({ baseUrl: 'http://localhost:3100' })`
  - `await runtime.runAgent({ role: 'writer', input: {...} })`
  - Typed methods: `runAgent`, `startRun`, `getStatus`, `resumeRun`, `cancelRun`, `waitForCompletion`, `health`

### Architecture
- **`AgentRuntimeService` (`src/runtime/agentRuntimeService.ts`)** — Transport-agnostic service layer extracted from MCP server. Shared by MCP tool handlers, HTTP server, and CLI. Clean API: `runSync()`, `startRun()`, `getRunStatus()`, `resumeRun()`, `cancelRun()`, `waitForCompletion()`.
- **Three build outputs** via esbuild: `dist/mcp-server.js` (MCP stdio), `dist/http-runtime.js` (HTTP REST), `dist/runtime-cli.js` (JSON CLI).
- **`RuntimeError`** class with `code` and `httpStatus` for clean error propagation across all transports.

### Compatibility
- MCP tool handlers (`run_agent`, `start_agent_run`, etc.) now delegate to the shared service — behavior is identical.
- Addresses [#517](https://github.com/cloga/optimus-code/issues/517): Host applications no longer need MCP transport.

## [2.14.0] - 2026-03-22

### Features
- **ACP persistent process pool** — Eliminates cold-start overhead (~1-2s) for ACP engine tasks by keeping agent processes alive between invocations:
  - First task spawns the ACP process and performs the `initialize` handshake
  - Subsequent tasks reuse the warm process — only `session/new` + `session/prompt` are needed
  - Idle processes are automatically evicted after 5 minutes
  - If a persistent process crashes, the next invocation auto-recovers (respawn + reinitialize)
  - When the pool adapter is busy with a concurrent task, an ephemeral adapter is created as fallback

### Architecture
- **`AcpProcessPool` (`src/utils/acpProcessPool.ts`)** — Singleton pool managing warm ACP adapter instances, keyed by engine. Provides idle sweep, graceful shutdown, and usage stats (reuses/creations).
- **`AcpAdapter` dual lifecycle** — Now supports both ephemeral (per-task spawn/kill, original behavior) and persistent (process stays alive) modes. New pool management API: `isAlive()`, `isBusy()`, `shutdown()`, `idleSince`, `invocationCount`.
- **Per-task MCP env injection** — In persistent mode, per-task environment variables (delegation depth, role, etc.) are injected into MCP server configs via `session/new` params, ensuring child processes get correct context even though the ACP process is reused.
- **Process crash safety** — Exit handler uses closure-captured process identity to prevent stale handlers from clobbering newly spawned processes during auto-recovery.

### Compatibility
- **Fully backward compatible** — Ephemeral adapters (non-pool) behave identically to before. The pool is transparent to the delegation system.

## [2.13.0] - 2026-03-22

### Features
- **Worktree orchestration tools** — 3 new MCP tools for automated multi-branch parallel development:
  - `create_worktree` — Create a git worktree for a branch, with automatic `.optimus/` state initialization
  - `list_worktrees` — List all active worktrees with branch, HEAD, and Optimus state status
  - `remove_worktree` — Clean up a worktree after work is complete
- **`branch` parameter on `delegate_task` / `delegate_task_async`** — When specified, automatically creates a worktree for the target branch and runs the agent there. Enables Master Agent to dispatch parallel feature work across isolated branches with zero git conflicts.

### Architecture
- **`WorktreeManager` (`src/utils/worktreeManager.ts`)** — Lifecycle management for git worktrees: create, list, find-by-branch, remove, ensure-for-branch. Auto-generates worktree paths using the convention `../<repo>-wt-<branch>/`.
- **Seamless delegation** — `spawnAsyncWorker` already passes `cwd: workspacePath` to child processes, so worktree-targeted tasks run in the correct directory with full state isolation (v2.12.0) and shared config/roles/skills from the main worktree.

### Compatibility
- **Fully backward compatible** — Omitting the `branch` parameter preserves existing single-workspace behavior. The 3 new tools are additive.

## [2.12.0] - 2026-03-22

### Features
- **Git worktree support** — Optimus now detects git worktrees and resolves `.optimus/` paths accordingly. Shared resources (config, dist, roles, skills, memory) resolve from the main worktree, while runtime state (task manifests, results, reviews, agent instances) stays isolated per worktree. This enables running multiple features simultaneously on one machine.
- **`ensureWorktreeStateDirs()` at server startup** — The MCP server automatically creates required state directories when running inside a worktree, so `optimus init` in the main worktree is all you need.
- **`optimus init` now detects worktree context** — Shows informational output about worktree status and whether the main worktree has `.optimus/` set up.

### Architecture
- **Centralized path resolution via `resolveOptimusPath()`** — All `.optimus/` path construction across 12+ source files now routes through `src/utils/worktree.ts`, replacing ~40 scattered `path.join()` calls. Paths are auto-categorized as shared or state based on the first directory segment.
- **Path categories**: `config`, `dist`, `roles`, `skills`, `memory`, `specs`, `tasks` → shared (main worktree). `state`, `results`, `reviews`, `system`, `agents` → per-worktree.

### Compatibility
- **Fully backward compatible** — Non-worktree workspaces behave identically (both roots resolve to the same directory). No changes to CLI commands, MCP tools, or configuration formats.

## [2.11.0] - 2026-03-22

### Features
- **First-class Agent Runtime abstraction** — New application-facing runtime layer above raw delegation and transport. Host applications can now call agents as domain services without coupling to `delegate_task`, CLI transport details, or task-manifest internals. Addresses #516.
- **5 new Agent Runtime MCP tools** — `run_agent` (sync execution), `start_agent_run` (async), `get_agent_run_status` (normalized polling), `resume_agent_run` (unblock manual intervention), `cancel_agent_run` (graceful cancellation).
- **Normalized result envelopes** — All runtime tools return a consistent `AgentRuntimeEnvelope` with `status`, `result`, `error_code`, `error_message`, `requires_manual_intervention`, `action_required`, and `runtime_metadata` (engine, model, session_id, duration_ms, retries_attempted).
- **Structured output validation** — When `output_schema` is provided, the runtime detects malformed JSON output and returns `error_code: "invalid_structured_output"` instead of silently passing broken data.
- **Engine fallback and retry policy** — `run_agent` supports `runtime_policy.retries` and `runtime_policy.fallback_engines` for automatic retry with engine rotation.
- **Task cancellation support** — New `cancelled` status in the task manifest. Running tasks respect cancellation; the async runner checks cancellation before writing final status.

### Fixes
- **Async tasks now record resolved engine, model, and session_id** — Worker spawner backfills `resolved_engine`, `resolved_model`, and `session_id` into the task manifest after execution, enabling runtime metadata to surface actual execution details.
- **`completed_at` timestamp added to task records** — Terminal task states now record completion time for accurate duration tracking.

### Compatibility
- **Backward compatible with existing orchestration tools** — `delegate_task`, `delegate_task_async`, `dispatch_council`, and `check_task_status` remain unchanged.
- **Recommended for application-side integrations** — Teams building domain services (script generation, classification, extraction, structured content generation) on top of Optimus should adopt the runtime tools for a stable contract.

## [2.10.0] - 2026-03-21

### Features
- **Unified project MCP config is now first-class** — Optimus now treats `.optimus/config/mcp-servers.json` as the single source of truth for workspace MCP server definitions instead of hardcoding `.vscode/mcp.json` as the canonical config.
- **`optimus init` / `optimus upgrade` now generate multi-client MCP configs** — Workspaces now get synchronized project-local MCP files for VS Code / GitHub Copilot (`.vscode/mcp.json`), GitHub Copilot CLI (`.copilot/mcp-config.json`), and Claude Code (`.mcp.json`) from one shared definition.

### Fixes
- **Claude Code and ACP flows no longer depend on VS Code config layout** — Runtime adapters now prefer the canonical Optimus MCP config and only fall back to legacy client files, removing the old coupling to `.vscode/mcp.json`.
- **Cross-platform workspace config is now portable across Windows and macOS** — Generated Claude and Copilot CLI config files use project-relative paths, while VS Code keeps its native workspace macro format.

### Compatibility
- **Existing VS Code-based workspaces remain supported** — Legacy `.vscode/mcp.json` workspaces still work as a fallback while newer workspaces can adopt the unified source config.
- **Recommended for teams validating multiple MCP clients** — This release is intended for shared testing across Claude Code, VS Code Copilot, and Copilot CLI with one project-owned configuration model.

## [2.9.0] - 2026-03-19

### Features
- **Azure DevOps `updateWorkItem` is now implemented** — The unified VCS layer can now update ADO work items through JSON Patch, including title, description, state, assignee, and priority changes.
- **`vcs_update_work_item` now exposes richer ADO fields** — MCP callers can pass `description`, `assigned_to`, and `priority`, while provider-specific workflow states are forwarded correctly for Azure DevOps.

### Fixes
- **GitHub update validation is stricter and clearer** — GitHub work-item updates now reject unsupported state values and unsupported field-only payloads with actionable errors instead of failing ambiguously.
- **Label-only GitHub updates no longer require a redundant issue patch** — The provider now refetches issue data when only labels change, preserving the unified update flow without unnecessary PATCH requests.

### Compatibility
- **Backward compatible for existing GitHub workflows** — GitHub retains its existing `open`/`closed` state model and label handling.
- **Recommended for mixed GitHub + ADO environments** — Teams using Azure DevOps now get parity for unified work-item updates without changing MCP tool names.

## [2.8.0] - 2026-03-19

### Features
- **Available-agents resolution is now explainable at runtime** — Engine selection no longer lives only in `worker-spawner.ts`. Optimus now exports a resolved explanation view with requested automation policy, candidate transports, final protocol choice, and selection reason.
- **New `explain_available_agents` MCP tool** — Agents and operators can query the fully resolved `available-agents.json` behavior directly, either for one engine or the full config, without re-implementing the resolver logic.
- **`roster_check` now shows resolved runtime behavior** — The roster output surfaces configured protocol, resolved protocol, requested automation, and why each engine resolves the way it does.

### Fixes
- **Explicit transport configs no longer masquerade as both protocols** — Runtime transport selection now correctly distinguishes pinned `cli` versus pinned `acp` engine declarations instead of treating one top-level config as valid for both protocol branches.
- **Engine resolution is now reusable instead of duplicated** — Transport preview, selection reason, and runtime adapter resolution now share a single explanation path, reducing drift between human-visible summaries and actual execution behavior.

### Compatibility
- **Backward compatible for existing configs** — Legacy `available-agents.json` shapes remain accepted, but the runtime surface is now more explicit and machine-readable.
- **Recommended upgrade for agent-native workflows** — If you rely on `protocol: "auto"`, upgrade to get explainability and more accurate runtime introspection.

## [2.7.0] - 2026-03-19

### Features
- **Copilot ACP transport is now first-class in engine config** — GitHub Copilot can be declared with `protocol: "auto"` and `preferred_protocol: "acp"`, with headless ACP launches defaulting to `copilot --acp --stdio` when ACP args are not explicitly provided.
- **Automation policy is now normalized across engines** — `automation.mode` and `automation.continuation` are treated as separate, explicit policy axes. Copilot CLI autopilot and ACP transport selection now resolve from the same config surface and are exposed consistently in the MCP entrypoints.
- **Async council dispatch gets immediate queued artifacts** — `dispatch_council_async` now creates `STATUS.md` and the task-manifest entry before background execution starts, improving observability for queued reviews.

### Fixes
- **Fail-fast automation/transport validation** — Invalid combinations such as Copilot ACP + `continuation: "autopilot"` or Claude + unsupported autopilot continuation are now rejected during engine resolution instead of failing later at runtime.
- **ACP session compatibility retries** — `AcpAdapter` now retries `session/prompt` and `session/load` with compatibility fallbacks when ACP servers reject one parameter shape, and falls back to a fresh session when persisted session resume is not accepted.
- **ADO links now resolve to browser URLs** — ADO work item creation/comment APIs now return stable web URLs, including GUID-backed project resolution and correct work item comment anchors.
- **Meta-cron and council capacity hardening** — stale lock files are detected and cleaned more safely, malformed engine config entries are excluded earlier, and council async queue setup is covered by dedicated Vitest tests.

### Compatibility
- **Low-risk for default users; review custom engine configs** — Legacy vendor-specific automation aliases are still parsed, but new configs should use normalized values such as `auto-approve`, `deny-unapproved`, `single`, and `autopilot`.
- **Copilot autopilot remains CLI-only** — ACP and autopilot are orthogonal concepts, but Copilot autopilot continuation is still only supported on the CLI transport. `protocol: "acp"` plus `continuation: "autopilot"` is intentionally rejected.

## [2.6.2] - 2026-03-16

### Fixes
- **`optimus init` auto-fills GitHub owner/repo from git remote** — No longer leaves owner/repo empty in `vcs.json`. Parses `git remote get-url origin` and fills `github.owner` and `github.repo` automatically. Fixes wrong-owner issue when init is run in org-owned repos.
- **SAML SSO 403 errors get clear remediation message** — GitHub 403 responses containing "SAML enforcement" now produce: "GitHub token is valid but NOT authorized for this organization via SAML SSO. Action required: authorize your token for the organization." Instead of generic "VCS unavailable". Applied to all 8 GitHub API call paths in GitHubProvider.

## [2.6.1] - 2026-03-16

### Fixes
- **`vcs_add_comment` Markdown→HTML for ADO** — Comments on ADO work items and PRs now auto-convert Markdown to HTML, matching `vcs_create_work_item` behavior. Fixes broken rendering of tables, headings, and formatting in ADO comments.

## [2.6.0] - 2026-03-16

### Features
- **Agent/Role Lifecycle GC** — Patrol new Phase 6.5: Agent Hygiene. Auto-cleans stale T1 agents (>7 days), orphaned lock files, and unused T2 roles (>30 days). Task manifest auto-trimmed to 30 days. (#475)

### Fixes
- **MCP server path resolution** — `optimus init`/`upgrade` now copies `mcp-server.js` to `.optimus/dist/` and uses `${workspaceFolder}` relative path in `mcp.json`. Fixes MCP server not starting after running from npx/temp directory. (#477)
- **npx ECOMPROMISED** — Removed `prepare` lifecycle scripts that triggered cascading builds during npx install, exceeding npm v11 lock timeout. (#471)

## [2.5.2] - 2026-03-16

### Fixes
- **AcpAdapter path resolution** — `loadMcpServers` now uses `OPTIMUS_WORKSPACE_ROOT` env var for reliable path resolution, fixing issues where the workspace root was incorrectly inferred.

## [2.5.1] - 2026-03-16

### Fixes
- **Scaffold `release-policy.json` missing from v2.5.0** — The auto-release opt-in config template (`enabled: false`) was referenced in the v2.5.0 release notes but was not included in the release commit. Added to `optimus-plugin/scaffold/config/`.

## [2.5.0] - 2026-03-16

### Features
- **`get_user_memory` MCP tool** — Master Agent can now read the same user preferences that sub-agents see. Single source of truth at `~/.optimus/memory/user-memory.md`.
- **ACP activity-based timeout** — Detects live-but-stuck ACP sessions (process alive but zero output). Default 20 min, configurable per-engine via `timeout.activity_ms`. Fixes 5+ hour zombie tasks (#433).
- **Delegation Scope Decision Matrix** — Added to system-instructions and delegate-task skill. Master now knows when to delegate to PM vs dev vs specialist (#393).
- **Competitive Discovery skill rewrite** — Now auto-adds high-confidence competitors (score ≥5) to watchlist via Read-Modify-Write protocol. Medium-confidence candidates go through `request_human_input`.
- **Auto-release skill + cron** — New `auto-release` skill with `release-gate` cron (every 4h). Conventional commits determine semver. `max_auto_bump: minor`. Scaffold default: `enabled: false` (opt-in).

### Improvements  
- **Master onboarding Step 0** — User Memory loading is now the first numbered step in master-onboarding skill for more reliable execution.

## [2.4.0] - 2026-03-16

### Features
- **`competitive-discovery` skill** — New weekly discovery skill for finding unknown competitors via GitHub topic search. Separate from daily monitoring. Weekly cron registered (`0 9 * * 1`).
- **9 new competitors added to watchlist** — Zeroshot, ComposioHQ/agent-orchestrator, Babysitter, OpenCastle, Ruflo, TAKT, DeerFlow, AG2, Google ADK.

### Improvements
- **Unified prompt for all engines** — Removed ACP lean prompt. All engines (CLI and ACP) now receive the same full prompt with inline memory, user memory, persona, skills, and context. Fixes: ACP sub-agents were missing user preferences and project memory because they didn't read the file paths provided in the lean prompt.

## [2.3.2] - 2026-03-15

### Fixes
- **Patrol no longer auto-closes `swarm-council` Issues** — Council `verified` only means the review finished, not that recommendations were implemented. Now only `swarm-task` verified Issues are closed. Council Issues get a status comment but stay open until manually closed.

## [2.3.1] - 2026-03-15

### Features
- **`optimus init` auto-creates Health Log Issue** — Detects GitHub repo from git remote, creates a "[Optimus] System Health Log" issue, and links it in `meta-crontab.json`. Patrol reports are appended as comments. Requires `GITHUB_TOKEN` in `.env`; skips gracefully if unavailable.

### Improvements
- **Scaffold default cron → `hourly-patrol`** — New workspaces get `hourly-patrol` (patrol-manager + project-patrol skill) instead of `night-steward`. No dry-run, `max_actions=999`.
- **VCS tools graceful degradation** — All 7 VCS tools (`vcs_create_work_item`, `vcs_create_pr`, `vcs_merge_pr`, `vcs_add_comment`, `vcs_update_work_item`, `vcs_list_work_items`, `vcs_list_pull_requests`) now return `⚠️ VCS unavailable` warning instead of crashing when no token or config is present. Agents continue working without Issue/PR tracking.

## [2.3.0] - 2026-03-15

### Features
- **`vcs_list_pull_requests` tool** — New VCS tool to list pull requests with state filter. Returns PR number, title, mergeable status (`clean`/`CONFLICTING`/`unknown`), head/base branches, and labels. Enables patrol PM to automatically discover and handle open PRs.

### Improvements
- **Patrol PR phase upgraded** — Patrol skill now uses `vcs_list_pull_requests` instead of unreliable `git log --remotes`. Adds decision matrix for conflicting bot PRs (auto-close) and conflicting human PRs (escalate via `request_human_input`).

## [2.2.1] - 2026-03-15

### Fixes
- **ACP sub-agents can now call MCP tools** — `AcpAdapter` was passing `mcpServers: []` to `session/new`, making sub-agents unable to call any MCP tools (e.g. `request_human_input`, `vcs_update_work_item`). Now reads `.vscode/mcp.json`, resolves `${workspaceFolder}`/`${env:VAR}` macros, and converts VS Code object format to ACP array format. Verified with `request_human_input` end-to-end test.

## [2.2.0] - 2026-03-15

### Features
- **`vcs_update_work_item` tool** — New VCS tool to update work items (close/reopen issues, change titles, add/remove labels). Platform-agnostic — works on both GitHub and Azure DevOps.
- **`vcs_list_work_items` tool** — New VCS tool to list work items with state and label filters. Replaces legacy `github_sync_board`.

### Breaking Changes
- **Removed `github_update_issue` and `github_sync_board`** — These legacy tool schemas had no handler implementation. Replaced by `vcs_update_work_item` and `vcs_list_work_items` which use the unified VCS provider layer.

### Fixes
- **Patrol PM was unable to close issues** — Root cause: patrol skill referenced `github_update_issue` which had a schema but no handler. All skill references updated to use `vcs_update_work_item` / `vcs_list_work_items`.

## [2.1.1] - 2026-03-15

### Fixes
- **Scaffold model name alignment** — Scaffold `available-agents.json` claude-code models changed from ACP-native names (`default`, `opus`, etc.) to standard identifiers (`claude-opus-4.6-1m`, `gpt-5.4`, `gemini-3-pro-preview`) matching project config.

## [2.1.0] - 2026-03-15

### Features
- **Autonomous Memory Writing** — Agents now autonomously write to project/role memory when encountering non-trivial lessons (bug postmortems, tool gotchas, conventions). Removed the previous "MUST NOT write" restriction.
- **User Memory auto-init** — `optimus init` now creates `~/.optimus/memory/user-memory.md` with a starter template. Also creates `.optimus/memory/roles/` directory for role-level memory.

## [2.0.0] - 2026-03-15

### Breaking Changes
- **Claude Code defaults to ACP protocol** — `claude-code` engine now uses `claude-agent-acp` (ACP protocol) instead of legacy CLI text parsing. `optimus init` and `optimus upgrade` auto-install `@zed-industries/claude-agent-acp`. No Anthropic API key needed — uses existing Claude Code OAuth session.

### Features
- **ACP Lean Prompt** — ACP engines receive a minimal prompt (role + task only). System instructions, memory, and skills are referenced by file path instead of inline injection. Reduces prompt from 40K+ chars to ~2K chars.
- **AcpAdapter Permission Auto-Approve** — Automatically approves `session/request_permission` requests from agents in headless mode. Fixes tool calls (file reads, etc.) hanging indefinitely.
- **AcpAdapter Windows PATH Resolution** — `shell: true` on Windows for ACP spawn, enabling simple command names like `claude-agent-acp` instead of absolute paths.
- **10-min Heartbeat Timeout Default** — All engines in scaffold now default to 600,000ms heartbeat timeout.
- **Competitive Intelligence v2** — Autonomous discovery with three-frequency model (daily monitor, weekly discovery, first-run bootstrap).

### Fixes
- **ACP complex task stall** — Root cause: `session/request_permission` from agent was unhandled, causing indefinite hang on any task involving tool calls. (#440)

## [1.2.0] - 2026-03-15

### Features
- **Configurable Task Timeouts** — Engine-level and per-task timeout overrides via `available-agents.json` `timeout` block and `timeout_ms` parameter on `delegate_task`. Resolution order: per-task > per-engine > hardcoded fallback. (#407)
- **AcpAdapter Claude Code Compatibility** — AcpAdapter now supports `claude-agent-acp` (Zed's Claude ACP bridge). Handles `cwd`/`mcpServers` in `session/new`, array prompt format, and `agent_message_chunk` streaming. (#413)
- **Patrol Auto-Close Task Issues** — Patrol PM now correlates open `swarm-task`/`swarm-council` Issues with `task-manifest.json` and auto-closes verified ones. Issue lineage cascade notifies parent Issues. (#415)
- **Competitive Intelligence Agent** — New `competitive-intel` meta-skill + `competitive-watchlist.json` config. Daily cron monitors competitor repos for releases, star velocity, and architectural changes. Escalates notable findings via `human-input-needed`. (#419)
- **Human Escalation Protocol** — Agents now have explicit rules for when to call `request_human_input`: strategic decisions, merge conflicts, repeated failures, missing credentials, destructive operations, and unmerged verified work. (#425)

### Fixes
- **Council role_descriptions not passed to manifest** — `dispatch_council_async` was not storing `role_descriptions` in the task manifest, causing new council roles (without pre-existing T2 templates) to consistently fail T3→T2 precipitation. (#428)

## [1.1.0] - 2026-03-15

### Features
- **Task Dependencies** — `delegate_task_async` now accepts `depends_on: [task_ids]`. Tasks register as `blocked` and auto-spawn when all dependencies are `verified`. (#395)
- **Meta-Cron Session Persistence** — Cron-triggered agents (e.g., patrol PM) now resume their previous session via `last_agent_id`, maintaining context across patrol cycles. (#398)
- **Patrol PM Diagnose & Re-delegate** — Patrol skill gains Phase 2.5: diagnoses open Issues by correlating with task manifest, auto-closes verified Issues, re-delegates failed tasks to last executor with session continuity. (#400)
- **Generic Release Process Skill** — `release-process` skill refactored into a config-driven meta-skill with `release-config.json` schema. Ships in scaffold for all users. (#403)
- **Configurable Timeouts** — Engine-level and per-task timeout overrides via `available-agents.json` and `timeout_ms` parameter on `delegate_task`. (#407)
- **Landing Page Claude Teams Comparison** — New "Optimus vs. Agent Teams" comparison section on both landing page and pitch deck.

## [1.0.6] - 2026-03-15

### Fixes
- **T2 Guard regression fix** — Thin T2 templates (existing but < 25 body lines, e.g., `pm.md`) were incorrectly triggering the new "missing role_description" error. Now: if a T2 file exists (even thin), delegation proceeds without requiring `role_description`. The error only fires when truly no T2 exists.

## [1.0.5] - 2026-03-15

### Features
- **Self-Execution Pre-Flight Rule** — Master Agent must now check `.optimus/skills/` for a matching Skill before executing any multi-step workflow. Added to both project and scaffold system-instructions.

### Fixes
- **Council Issue title readability** — `dispatch_council_async` now extracts the topic from the proposal's `# PROBLEM:` / `# PROPOSAL:` heading instead of using the filename. Issue titles change from `[Council] 00 PROBLEM (Review)` to `[Council] Agent-driven automation architecture (Review)`. (fixes #392)

## [1.0.4] - 2026-03-15

### Features
- **Multi-Level Memory System** — New `MemoryManager.ts` with project + role memory scopes, YAML frontmatter parser, relevance scoring (+3 role match, +2 recency), tiered token budgets, and greedy-fill loader. `append_memory` now accepts `level: "project" | "role"`. Workers receive `OPTIMUS_CURRENT_ROLE` env var. (#375)
- **User-Level Cross-Project Memory** — Opt-in `~/.optimus/memory/user-memory.md` for persistent user preferences across projects. `append_memory` accepts `level: "user"` with write-time safety filtering. `optimus memory` CLI subcommands: init, list, edit, add, remove. CI-guarded (disabled when `CI=true`). (#380)
- **Context Continuity System** — New `list_knowledge` MCP tool returns structured manifest of all `.optimus/` artifacts (specs, memory, reports, reviews). Master delegation pre-flight now includes Context Check step. Sub-agents can self-discover context. (#381)

### Fixes
- **Enforce T3→T2→T1 lifecycle** — `ensureT2Role` now throws an error (instead of silent null) when `role_description` is missing for a new role. T1 instance creation skipped when no T2 exists, preventing orphaned empty-shell agent files.

## [1.0.3] - 2026-03-14

### Features
- **Master Onboarding Skill** — New `master-onboarding` skill teaches Master Agent the first-run protocol (read system-instructions, roster_check, Problem-First SDLC)
- **Inject Template v2** — IDE configs now prompt "First action: read master-onboarding SKILL.md" on every session
- **Role Creation Decision Rules** — Master must roster_check before creating roles, no near-duplicates, require role_description

### Fixes
- **Auto-label all VCS items** — `vcs_create_work_item` and `vcs_create_pr` now auto-append `optimus-bot` label

## [1.0.2] - 2026-03-14

### Features
- **Skills Quick Reference expanded** — Critical constraints (async-only, roster_check first, no busy-poll) inlined into system-instructions for delegate-task, council-review, git-workflow
- **Sync dispatch_council warning** — Returns a warning nudging users toward dispatch_council_async
- **Docs updated for v1.0.0** — ARCHITECTURE.md, HYBRID_SDLC.md, building-autonomous-swarm-guide.md, IDEA_AND_ARCHITECTURE.md

### Fixes
- Remove orphan code: MemoryManager.ts, SharedTaskStateManager.ts, Calculator.ts (1035 lines deleted)

## [1.0.1] - 2026-03-14

### Features
- **Qwen Code Auto-Discovery**: ACP engine config supports `"path": "auto"` — automatically scans `~/.vscode/extensions/` for Qwen Code CLI, no hardcoded paths needed
- Scaffold now ships qwen-code engine entry with auto-discovery (users just need Qwen Code VS Code extension installed)

### Fixes
- Fix AcpAdapter TypeScript errors (invalid `chat` mode, undefined `encodeMessage`)
- Fix scaffold `available-agents.json` leaking local paths

## [1.0.0] - 2026-03-14

### Features
- **ACP Protocol Support**: Implement AcpAdapter with NDJSON-based JSON-RPC transport, verified with Qwen Code CLI
- **Multi-ACP Vendor Architecture**: Engine config uses `protocol` field to route adapters — add new ACP vendors (Kimi, Cursor, etc.) with zero code changes
- **Problem-First SDLC Workflow**: New lifecycle: PROBLEM → PROPOSAL → SOLUTION → EXECUTE, replacing the old proposal-first approach
- **Artifact Directory Routing Table**: Centralized routing rules in system-instructions.md — every agent knows what goes where
- **YAML Frontmatter Format Templates**: 7 artifact types with standardized templates (PROBLEM, PROPOSAL, SOLUTION, VERDICT, task result, report, review)
- **Cross-Model Council Diversity**: Automatic greedy round-robin assignment of engine:model combos to council participants
- **VERDICT Template Externalization**: Council verdict format loaded from `.optimus/config/verdict-template.md` (customizable)
- **Mandatory Council Review Rule**: High-impact changes require expert council review before implementation
- **Engine Health Tracking & Fallback**: Per engine:model health tracking with automatic fallback on failures
- **Agent Pause/Resume**: Human-in-the-loop input mechanism via `request_human_input`
- **Patrol Manager System**: `project-patrol` skill with automated cron-based project monitoring
- **Docs Site Enhancements**: Interactive tutorial guide, investor pitch page, bilingual EN/ZH support, terminal hero animation
- **Init/Upgrade**: Scaffold now includes `specs/` and `results/` directories, `verdict-template.md`, protocol field in config

### Fixes
- **Strip Tool-Call Traces from Output**: Artifact files no longer contain adapter process traces (GPT-5.4/Claude Opus outputs now clean)
- **ESM/CJS Bundling**: Bundle all deps via esbuild to eliminate runtime crashes
- **Windows Path Mangling**: Prevent backslash issues in agent delegations
- **Meta-Cron Race Condition**: Fix concurrent cron execution and add log capture
- **strip-ansi CJS Compatibility**: Downgrade to v6 for CommonJS support

### Improvements
- **Consolidated System Prompt**: Single Source of Truth at `.optimus/config/system-instructions.md`
- **Frozen `proposals/` Directory**: New work goes to `specs/`, legacy proposals preserved
- **Replaced `protocol.md`**: Obsolete blackboard protocol replaced with redirect stub
- **Release Process Skill v1.1**: Fixed scaffold sync rules, added validation warnings

## [0.4.0] - 2026-03-12

### Features
- Inject project memory into agent prompts at spawn time (#181)
- Add release-process skill SOP (#189)
- Default to squash merge and sync local master after merge (#185)
- Add agent attribution signatures to all VCS tools (#152)
- Inject auto-created issue ID into agent prompt to prevent duplicates (#166)
- Implement agent retirement, quarantine and T1 GC (#161)
- Role-skill decoupling, enhance roster_check (#163)
- Ensure optimus-bot label on all auto-created issues (#153)
- Auto-delete source branch after PR merge (#150)

### Fixes
- Preserve user config during optimus upgrade (#175)
- Prevent async council tasks from getting stuck in running state (#64)

### Improvements
- Add systemic safeguards from vcs.json wipe postmortem (#178)
- Fix misleading MCP config section in Quick Start (#176)
- Update README and system-instructions for v0.3.0 features (#144)
- Enforce issue lineage in skills and instructions (#155)
- Remove auto-skill genesis (#160)

## [0.3.0] — 2026-03-12

### Features
- **Delegation Depth Control** — `MAX_DELEGATION_DEPTH = 3` prevents infinite agent recursion. Tracked via `OPTIMUS_DELEGATION_DEPTH` env var.
- **Plan Mode for Orchestrators** — `mode: plan` strips write permissions from PM/orchestrator roles, forcing delegation instead of direct coding.
- **`write_blackboard_artifact` MCP Tool** — Allows plan-mode agents to write exclusively to `.optimus/` directory with symlink-safe path validation.
- **Issue Lineage Tracking** — `OPTIMUS_PARENT_ISSUE` env var injected into child agents, enabling GitHub Issue parent-child tree visualization.
- **`optimus upgrade` CLI Command** — Safe incremental upgrade that force-updates skills/roles/config while preserving user agents and runtime data.
- **Enhanced ADO `vcs_create_work_item`** — New params (`area_path`, `iteration_path`, `assigned_to`, `parent_id`, `priority`), `vcs.json` defaults section, auto-tag `created-by:optimus-code`, Markdown→HTML body conversion.
- **Auto-Skill Genesis** — Auto-generate `SKILL.md` after successful T3 precipitation so new roles are born with operational playbooks.
- **Rich T3→T2 Precipitation via `agent-creator`** — Replace thin `fs.writeFileSync` templates with full `agent-creator` invocation for professional-grade role definitions.
- **Engine/Model Validation** — Validate engine and model names against `available-agents.json` before writing to T2 frontmatter, preventing invalid engine corruption.

### Improvements
- Feature-dev skill rewritten with 6-phase PM-driven autonomous workflow
- Senior Full-Stack Developer role replaces generic dev
- Session Continuity Rule for agent memory reuse
- Environment variable interpolation fix for nested MCP worker processes
- Explicit tool call examples added to each feature-dev phase

## [Unreleased]

### Self-Evolving Agent System (T3→T2→T1 Complete Lifecycle)
- **T3→T2 Immediate Precipitation**: First-time T3 role usage auto-creates a T2 role template in `.optimus/roles/`. No threshold — instant on first delegation.
- **T2→T1 Session Instantiation**: When a task completes and returns a session_id, the system auto-creates a T1 agent instance in `.optimus/agents/` from the T2 template. T1 is frozen after creation.
- **Master-Driven T2 Evolution**: Master Agent can update T2 templates with new `role_description`, `role_engine`, `role_model` via `delegate_task` params. T1 instances are never retroactively modified.
- **Structured `delegate_task` Params**: Added `role_description`, `role_engine`, `role_model`, `required_skills` fields. Master Agent provides all T2 info — no more guessing.
- **Engine/Model Fallback Chain**: Master override → frontmatter → `available-agents.json` → `claude-code` hardcoded fallback.

### Skill System
- **Skill Pre-Flight Check**: `required_skills` field in `delegate_task`/`delegate_task_async`. Missing skills → rejection with actionable error listing what to create.
- **Skill Auto-Injection**: Found skills automatically injected into agent prompt as EQUIPPED SKILLS section.
- **`skill-creator` Bootstrap Meta-Skill**: Teaches agents how to create new SKILL.md files.
- **`agent-creator` Bootstrap Meta-Skill**: Teaches Master Agent the T3→T2→T1 lifecycle, role selection, engine binding.

### Infrastructure
- **DOTENV_PATH via `mcp.json` env mount**: Replaces hardcoded `.env` path. Users can point to any env file.
- **Auto-generate `.vscode/mcp.json`**: `optimus init` creates or merges MCP config for VS Code/Copilot users.
- **`[Optimus]` Auto-Tagging**: All Issues/PRs created via MCP tools get `[Optimus]` prefix and `optimus-bot` label.
- **Zero-Config Scaffold**: `optimus init` ships no pre-built roles/agents. System bootstraps at runtime.
- **Inject-Only Instruction Bridging**: `optimus init` appends reference to existing `CLAUDE.md`/`copilot-instructions.md` but never creates new ones.
- **Windows CRLF Fix**: `parseFrontmatter` normalizes `\r\n` for cross-platform compatibility.
- **Path Traversal Prevention**: `sanitizeRoleName()` strips dangerous characters from role names.
- **T3 Log File Mutex**: Prevents concurrent write corruption on `t3-usage-log.json`.
- **`windowsHide: true`**: Background child processes no longer pop up terminal windows.

### Removed
- Lazy-sync of built-in roles to user projects (was polluting `.optimus/roles/` with phantom T2 files)
- Instruction bridging that copied full `system-instructions.md` content into `CLAUDE.md`
- Threshold-based precipitation (was 3 invocations + 80% success rate, now immediate)

## [0.0.8] - 2026-03-08
- **Enhancement: Planner Consensus Voting Threshold**: `_computeIntentFromPlanners()` now requires `min(2, numPlanners)` agreeing votes before routing to `action` or `skip`. Single-planner setups behave as before; with 2+ planners, at least 2 must agree, preventing a single aggressive planner from overriding the majority.
- **Fix: Plan Synthesis Without Dedicated Executor**: In plan mode with multiple planners but no executor configured, the synthesis step now falls back to the first plan adapter (invoked in read-only `plan` mode). Previously, synthesis was silently skipped, forcing users to manually reconcile planner outputs.
- **UI: Plan Synthesis Label**: The synthesis output is now labelled `📋 <AgentName> (Plan Summary)` in the UI to distinguish it from individual planner outputs.

## [0.0.6] - 2026-03-08
- **Feature: Smart auto-routing (`inferMode`)**: When mode is set to Auto (default), prompt heuristics now automatically route pure questions to Plan mode and short explicit edits (with prior context) to Direct mode. Reduces unnecessary planner+executor round-trips for straightforward interactions.
- **Feature: Prompt prefix shortcuts**: Type `/plan <prompt>` or `/exec <prompt>` (or `/direct`) to override the mode for a single submission without touching the mode buttons. The prefix is stripped before the prompt reaches the host.
- **Feature: Mode inference indicator**: When smart auto-routing changes the mode, a small inline notification ("⚡ Auto-routed to Plan mode") appears in the chat so the user knows which execution path was taken.
- **Feature: Three-mode execution routing**: Added a Plan / Auto / Exec toggle in the input area. **Plan** runs planners only (analysis without code changes). **Auto** (default) runs the full planner → executor pipeline. **Exec** skips planners and sends user prompt directly to the executor for immediate action. Mode selection is preserved in queue items.
- **Feature: Queue persistence**: Pending queue items are now saved to VS Code `globalState` and restored when the webview reloads or VS Code restarts, preventing queued prompts from being lost.
- **Feature: Queue content visibility**: A collapsible panel below the Queue button shows all queued prompts (truncated to 60 chars) with per-item delete (`✕`) support. Click the badge count to toggle.
- **Fix: Execution Trace leak in summary**: `ExecutorOutcomeRecord.summary` now uses the clean output (post `_extractThinking`) instead of `execCleaned`, preventing tool trace markers (`•`, `✓`, `✗`, `↳`) from leaking into the task state summary strip.
- **Fix: Multi-line process line handling**: `appendProcessLines` now splits multi-line entries (e.g. `"• tool\n↳ summary"`) into individual lines before dedup, preventing malformed process text accumulation.
- **Fix: Consistent result preview label**: Unified `first=` to `preview=` in `summarizeStructuredToolResult` for multi-line results, matching the format already used by bash/shell tool-specific summarization.
- **Fix: Copilot adapter missing `captureProcessLinesAfterOutputStarts`**: `GitHubCopilotAdapter.extractThinking()` now sets `captureProcessLinesAfterOutputStarts: true`, so tool trace lines appearing after LLM output starts are correctly moved to `thinking` instead of leaking into `output`.
- **Fix: Incomplete process line regexes**: Both `COPILOT_PROCESS_LINE_RE` and `CLAUDE_PROCESS_LINE_RE` now include `↳`, `✓`, and `✗` characters, ensuring continuation and completion markers are recognized as process lines.
- **Fix: Defense-in-depth in `_summarizeText`**: `_summarizeText()` now strips tool trace lines (starting with `•`, `✓`, `✗`, `↳`, etc.) before collapsing whitespace, preventing any residual trace markers from reaching the summary.
- **Fix: History resume scrolls to last 3 turns**: `restoreTaskSessions` now positions the scroll to the most recent 3 turns instead of jumping to the top.
- **Fix: Direct mode hides dropped planner indicator**: The "is not currently available" notification for dropped planners is now suppressed in Direct mode to avoid confusing messages.

## [0.0.5] - 2026-03-08
- **Repo Cleanup**: Removed debug log files, temp test scripts, and `temp_debug/` directory from root.
- **Gitignore Fix**: Replaced garbled `.gitignore` entries with clean rules; added patterns for `*.log`, `[LOG]`, `temp/`, `temp_debug/`.

## [0.0.4] - 2026-03-08
- **Modes-aware Agent Selection**: Agents now declare `modes: string[]`. Planning agent checkboxes show only agents with `"plan"` mode; executor dropdown shows only agents with `"agent"` mode.
- **Council → Executor Two-Phase Pipeline**: Phase 1 runs all selected planners concurrently; Phase 2 feeds synthesized plans to a single designated executor in `agent` mode.
- **Multi-turn Shared Task State**: `SharedTaskStateManager` tracks task history, open questions, blocked reasons, and auto-compacts context when token usage exceeds threshold.
- **Active Editor Context Injection**: The visible code range (or selection) from the active editor is automatically prepended to every planner prompt.
- **Streaming Callbacks Debounced**: Per-agent streaming updates are debounced at 100 ms to reduce webview re-render churn.
- **Image Paste Support**: Users can paste images into the prompt bar; images are saved to global storage and their paths are injected into the prompt.
- **Apply Code Block**: Executor output code blocks can be applied directly to workspace files via a one-click button.
- **Task Resume / Rename / Delete / Pin**: Full task lifecycle management from the history panel.
- **Debug Mode**: Optional `optimusCode.debugMode` setting surfaces per-adapter command, cwd, pid, and token usage in the UI.
- **Code Quality Fixes**: Replaced inline ANSI regex with shared `ANSI_RE` utility; extracted `_buildDebugObject` helper to eliminate duplicate debug-info construction; fixed `ReturnType<...>[0]` type annotations to use `AgentAdapter`; removed TOCTOU race in image storage; capped history view at 20 turns; added random suffix to image filenames to prevent collisions.

## [0.0.3] - 2026-03-07
- **Architecture Direction Clarified**: Documented the long-term move toward app-level multi-turn shared task state, including structured planner contributions, resumable task history, and executor context synthesis owned by the orchestrator layer.
- **UI Evolution**: Abandoned the vertical chat layout in favor of a Side-by-Side "Kanban Card" approach, allowing multiple models to dynamically run horizontally without drowning out the conversation. Added rich-text Markdown formatting using `marked`.
- **Architectural Shift - Dynamic Configuration**: Removed hardcoded Agent registries. The extension now deeply integrates with VS Code `workspace.getConfiguration`, enabling users to swap Models (`gpt-5.4`, `claude-opus-4.6`, etc.) on the fly without a reload.
- **Session History Persistence**: Added a "History" toggle to the chat sidebar. Conversations and agent responses are now persisted in `context.globalState` across VS Code sessions. Users can pull up previous architectural discussions instantly.
- **Architectural Shift - Streaming Execution**: Completely refactored the underlying OS execution layer from synchronous `cp.exec` to asynchronous continuous streams via `cp.spawn`. This immediately pumps stdout/stderr token-by-token directly to Webview.
- **Removed Hard Timeouts**: Set `timeout: 0` for all CLI tool executions, giving advanced Coding Agents the infinite runtime needed to utilize their own terminal-based "tools/skills" before formulating an output.
- **Structural Standardization**: Refactored project directory structure, moving extension components into `src/providers/` and standardizing the architecture according to project documentation.
- **Dependency Cleanup**: Removed `DoubaoAdapter` place-holder to keep the underlying structure clean but natively backwards compatible to ANY future adapter type string inputs.

## [0.0.2] - 2026-03-07
- Implemented asynchronous streamed UX updates. Instead of blocking the UI until all models finish, the chat interface now renders a dedicated task list indicating which agents are "Thinking" (🔄), completed (✅), or failed (❌).

## [0.0.1] - 2026-03-07
- Initial MVP creation.
- Shifted architecture from command-palette invocation to a persistent **Sidebar Webview Chat**.
- Implemented **Adapter Design Pattern** in `src/adapters/`.
