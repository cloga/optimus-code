# Changelog

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