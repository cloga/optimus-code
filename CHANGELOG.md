# Changelog

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