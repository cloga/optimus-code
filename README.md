<div align="center">
  <h1>Optimus Code</h1>
  <p><b>Universal Multi-Agent Orchestrator for any MCP-compatible AI coding tool.</b></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Framework: Model Context Protocol](https://img.shields.io/badge/MCP-Native-brightgreen.svg)](#)

  [Landing Page](https://cloga.github.io/optimus-code/) · [Architecture Whitepaper](docs/ARCHITECTURE.md)
</div>

---

## What is Optimus Code?

Optimus Code is a **Multi-Agent Orchestration Engine** built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It works with **any MCP-compatible client** — VS Code (GitHub Copilot), Cursor, Windsurf, Claude Code, Goose, Roo Cline, and more.

It transforms a single AI assistant into a coordinated swarm of specialized agents (Architect, PM, QA, Dev…) that can collaborate, debate, and execute complex software engineering tasks.

> **100% editor-agnostic.** Pure Node.js MCP Server. No VS Code extension required.

---

## Quick Start

> **For AI Coding Agents:** Follow these steps exactly. All commands should run in the user's target project directory.

### Step 1: Initialize workspace

```bash
npx -y github:cloga/optimus-code init
```

This creates a `.optimus/` folder with agent definitions, skills, and config in the current directory. It also writes a canonical MCP source file at `.optimus/config/mcp-servers.json` and generates client configs for:

- VS Code / GitHub Copilot: `.vscode/mcp.json`
- GitHub Copilot CLI: `.copilot/mcp-config.json`
- Claude Code: `.mcp.json`

For GitHub Copilot CLI, Optimus also generates launcher scripts so you do not need to remember `--additional-mcp-config`:

- Windows PowerShell: `copilot-optimus.ps1`
- Windows cmd.exe: `copilot-optimus.cmd`
- macOS / Linux: `copilot-optimus`

### Step 2: (Optional) Configure MCP for non-VS-Code clients

> **VS Code and Claude Code users:** Skip this step. `optimus init` already generated the project-local MCP files those clients expect.
>
> **GitHub Copilot CLI users:** Start Copilot CLI through one of the generated `copilot-optimus*` launchers so the project-local `.copilot/mcp-config.json` is always loaded.

For Cursor, Windsurf, Roo Cline, or other MCP clients, configure manually:

#### Cursor / Windsurf / Roo Cline

Create or edit `.cursor/mcp.json` (or equivalent) in the project root:

```json
{
  "mcpServers": {
    "optimus-swarm": {
      "command": "npx",
      "args": ["-y", "github:cloga/optimus-code", "serve"],
      "type": "stdio"
    }
  }
}
```

#### Any other MCP client

Use these values in your client's MCP server configuration:

| Field | Value |
|---|---|
| **name** | `optimus-swarm` |
| **command** | `npx` |
| **args** | `["-y", "github:cloga/optimus-code", "serve"]` |
| **transport** | `stdio` |

### Upgrading an existing workspace

If you've previously initialized and want to update to the latest skills, roles, and config:

```bash
npx -y github:cloga/optimus-code upgrade
npx -y github:cloga/optimus-code upgrade --disable-project-available-agents
```

This force-updates skills, roles, and config from the latest release while preserving your agents (`.optimus/agents/`), runtime data (`.optimus/state/`), and memory. It also regenerates `.vscode/mcp.json`, `.copilot/mcp-config.json`, `.mcp.json`, and the `copilot-optimus*` launchers from `.optimus/config/mcp-servers.json`.

In other words, `optimus upgrade` upgrades the current workspace. When you run it via `npx github:cloga/optimus-code upgrade`, you also pick up the latest published CLI package itself, including `optimus go`.

If you want to adopt the new user-level `available-agents.json` default after previously using a project-level override, pass `--disable-project-available-agents`. Upgrade will rename `.optimus/config/available-agents.json` to a non-active backup such as `.optimus/config/available-agents.project.disabled.json`, then refresh the project sample file so user-level config becomes authoritative again.

### Jumping between Optimus projects

Optimus keeps a global registry of initialized workspaces at `~/.optimus/projects.json`. Every `optimus init` and `optimus upgrade` automatically registers the current project there.

Use `optimus go` to launch an agent CLI (Copilot or Claude) for any registered Optimus workspace without manually `cd`-ing first:

```bash
optimus go                              # interactive project picker
optimus go FlightReview                 # launch with default CLI (copilot)
optimus go FR --cli claude              # override CLI for this launch
optimus go FR --continue                # pass-through flags to the CLI
optimus go --scan                       # discover and register projects
```

The CLI periodically checks GitHub releases and prints an update notice when a newer version is available. The notice is skipped for `optimus serve` so MCP stdio output stays clean.

#### Multi-CLI support

`optimus go` supports both GitHub Copilot CLI and Claude Code CLI. Each project can have a preferred CLI, and you can override it per-launch:

```bash
# Set global default CLI
optimus go set-default-cli claude

# Set per-project preferred CLI
optimus go set-cli FlightReview copilot
optimus go set-cli SydneyEvaluation claude

# Override at launch time (always wins)
optimus go FR --cli claude
```

Resolution order: `--cli` flag → project `preferredCli` → global `defaults.cli` → `copilot`

### MCP configuration model

Optimus now treats `.optimus/config/mcp-servers.json` as the single source of truth for workspace MCP server definitions. Edit that file when you want to customize the local Optimus server entry, then run `optimus upgrade` (or regenerate via init in a fresh workspace) to project the same server into each supported client config.

### Step 3: (Optional) Enable GitHub integration

Create a `.env` file in your project root:

```bash
GITHUB_TOKEN=ghp_your_token_here
```

This enables automated Issue tracking and PR creation via the built-in PM agent.

### Step 3b: (Optional) Enable Azure DevOps integration

Create `.optimus/config/vcs.json`:

```json
{
  "provider": "azure-devops",
  "ado": {
    "organization": "your-org",
    "project": "your-project",
    "auth": "env:ADO_PAT",
    "defaults": {
      "work_item_type": "User Story",
      "area_path": "Project\\Team\\Area",
      "iteration_path": "Project\\Sprint 1",
      "assigned_to": "user@example.com",
      "auto_tags": ["created-by:optimus-code"]
    }
  }
}
```

The `defaults` section is optional. Any field not provided will use ADO project defaults. All defaults can be overridden per-call via MCP tool parameters.

---

## Available MCP Tools

Once the server is running, your AI assistant gains these tools:

| Tool | Description |
|---|---|
| `roster_check` | List all available agent roles (T1 local + T2 project + T3 dynamic) and engine/model bindings |
| `explain_available_agents` | Show the resolved runtime behavior of `available-agents.json`, including candidate transports, selected protocol, and fallback reasons |
| `run_agent` | Run an application-facing Agent Runtime request synchronously and return a normalized envelope |
| `start_agent_run` | Start an application-facing Agent Runtime request asynchronously |
| `get_agent_run_status` | Read the normalized status/result envelope for an Agent Runtime run |
| `resume_agent_run` | Resume a run blocked on manual intervention by supplying the human answer directly |
| `cancel_agent_run` | Cancel an active Agent Runtime run |
| `delegate_task` | Assign a task to a specialized agent with structured role info |
| `delegate_task_async` | Same as above, non-blocking (preferred) |
| `dispatch_council` | Spawn parallel expert review (Map-Reduce pattern) |
| `dispatch_council_async` | Same as above, non-blocking (preferred) |
| `check_task_status` | Poll async task/council completion |
| `append_memory` | Save learnings to persistent agent memory |
| `write_blackboard_artifact` | Write artifacts to `.optimus/` (specs, tasks, reports). See routing table in system-instructions |
| `vcs_create_work_item` | Create a work item (GitHub Issue / ADO Work Item) via unified VCS abstraction |
| `vcs_create_pr` | Create a Pull Request via unified VCS abstraction |
| `vcs_merge_pr` | Merge a Pull Request via unified VCS abstraction |
| `vcs_add_comment` | Add a comment to a work item or PR (requires `item_type`) |
| `vcs_update_work_item` | Update an existing work item title/state/labels, plus ADO description, assignee, and priority |
| `vcs_list_work_items` | List work items with state/label filters |
| `vcs_list_pull_requests` | List pull requests with state filter, mergeable status |
| `request_human_input` | Pause execution and ask the human for input |
| `quarantine_role` | Quarantine/unquarantine a misbehaving role |
| `register_meta_cron` | Register a scheduled recurring task |
| `list_meta_crons` | List all registered scheduled tasks |
| `remove_meta_cron` | Remove a scheduled task |

### Agent Runtime tools

The Agent Runtime layer is the application-facing abstraction above raw delegation and transport. It is intended for host applications that want a stable runtime contract without coupling service code to `delegate_task`, CLI transport details, or task-manifest internals.

Typical flow:

1. `run_agent` for synchronous request/response execution
2. `start_agent_run` for async execution
3. `get_agent_run_status` to poll a normalized envelope
4. `resume_agent_run` when status is `blocked_manual_intervention`
5. `cancel_agent_run` to stop an active run

### delegate_task Extended Parameters

| Parameter | Required | Description |
|---|---|---|
| `role` | ✅ | Role name (e.g., `security-auditor`) |
| `role_description` | | What this role does — used to generate T2 template |
| `role_engine` | | Which engine (e.g., `claude-code`, `github-copilot`, `qwen-code`) |
| `role_model` | | Which model (e.g., `claude-opus-4.6-1m`, `qwen3-coder`) |
| `task_description` | ✅ | Detailed task instructions |
| `output_path` | ✅ | Where to write results |
| `workspace_path` | ✅ | Project root path |
| `context_files` | | Files the agent must read |
| `required_skills` | | Skills the agent needs (pre-flight checked) |

---

## Features

### v1.0.0 Highlights

- **ACP Protocol Support** — Universal [Agent Client Protocol](https://github.com/anthropics/agent-protocol) adapter enables integration with domestic AI coding agents (Qwen Code, Kimi, Cursor, etc.) via JSON-RPC over NDJSON.
- **Multi-Vendor Engine Architecture** — Engine config uses `protocol` field (`cli` | `acp`) to route adapters. Add new ACP vendors with zero code changes — just a JSON config entry.
- **Problem-First SDLC Workflow** — New lifecycle: PROBLEM → PROPOSAL → SOLUTION → EXECUTE replaces the old proposal-first approach. Experts propose independently before synthesis.
- **Artifact Directory Routing** — Centralized routing table in system-instructions defines where every artifact type goes (`specs/`, `results/`, `reviews/`, `reports/`, `tasks/`).
- **Format Templates** — 7 artifact types with standardized YAML frontmatter and required sections for cross-agent consistency.
- **Cross-Model Council Diversity** — Automatic round-robin assignment of engine:model combinations to council participants, maximizing model diversity by default.
- **Customizable VERDICT Template** — Council verdict format loaded from `.optimus/config/verdict-template.md` instead of hardcoded in code.
- **Clean Artifact Output** — Tool-call traces stripped from output files, ensuring downstream agents receive clean content.
- **Engine Health Tracking** — Per engine:model health monitoring with automatic fallback on consecutive failures.

### v0.4.0 Highlights

- **Agent Pause/Resume** — Human-in-the-loop input via `request_human_input` tool.
- **Project Patrol** — Automated cron-based project monitoring with `project-patrol` skill.
- **Mandatory Council Review** — High-impact changes require expert council review before implementation.

### v0.3.0 Highlights

- **Plan Mode** — Orchestrator roles (PM, Architect) run with `mode: plan`, cannot write source code, and must delegate implementation to dev roles.
- **Delegation Depth Control** — Maximum 3 layers of nested agent delegation, tracked via `OPTIMUS_DELEGATION_DEPTH` to prevent infinite recursion.
- **Issue Lineage Tracking** — `OPTIMUS_PARENT_ISSUE` is automatically injected into child agent processes, maintaining parent-child relationships across GitHub Issues.
- **`write_blackboard_artifact` Tool** — Allows plan-mode agents to write proposals, requirements, and reports to `.optimus/` without source code write access.
- **`optimus upgrade` Command** — Safe incremental upgrade that refreshes skills, roles, and config while preserving user agents and runtime data.
- **Enhanced ADO Work Items** — `vcs_create_work_item` supports `area_path`, `iteration_path`, `assigned_to`, `parent_id`, `priority` with `vcs.json` defaults, Markdown→HTML conversion, and auto-tagging.
- **Engine/Model Validation** — Engine and model names are validated against `available-agents.json` before being persisted to role templates.
- **Auto-Skill Genesis** — Skills are auto-generated after successful T3 role execution.
- **Rich T3→T2 Precipitation** — New roles get professional-grade role definitions via `role-creator` instead of thin fallback templates.

## How It Works

### Self-Evolving Agent Lifecycle (T3→T2→T1)

```
User request → Master Agent
                   │
                   ├─① roster_check (see who's available)
                   │
                   ├─② Select/create role (role-creator meta-skill)
                   │     └─ T3 first use → auto-creates T2 role template
                   │
                   ├─③ Check/create skills (skill-creator meta-skill)
                   │     └─ Missing? → delegate to skill-creator → retry
                   │
                   ├─④ delegate_task_async → agent executes
                   │
                   └─⑤ Session captured → T2 instantiates to T1
```

| Tier | Location | What It Is | Created By |
|------|----------|-----------|------------|
| **T3** | *(ephemeral)* | Zero-shot dynamic worker, no file | Master Agent names it |
| **T2** | `.optimus/roles/<name>.md` | Role template with engine/model binding | Auto-precipitated on first use, Master can evolve it |
| **T1** | `.optimus/agents/<name>.md` | Frozen instance snapshot + session state | Auto-created when task completes with session_id |

**Key invariants:**
- T2 ≥ T1 (every agent instance has a role template)
- T1 is frozen — only `session_id` updates on re-use
- T2 is alive — Master Agent evolves it over time

### Bootstrap Meta-Skills

The system ships with 5 pre-installed skills. Two are **meta-skills** that enable self-evolution:

| Skill | Type | Purpose |
|-------|------|---------|
| `role-creator` | 🧬 Meta | Teaches Master how to build & evolve the team |
| `skill-creator` | 🧬 Meta | Teaches Master how to create new skills |
| `delegate-task` | Core | Async-first task delegation protocol |
| `council-review` | Core | Parallel expert review (Map-Reduce) |
| `git-workflow` | Core | Issue First + PR workflow |

### Supported Adapters

| Adapter | Protocol | Compatible Agents |
|---------|----------|-------------------|
| `github-copilot` | Copilot CLI text parsing | GitHub Copilot |
| `claude-code` | Claude Code CLI text parsing | Claude Code |
| `acp` | ACP (Agent Client Protocol) — JSON-RPC over stdio | claude-agent-acp, Claude Code, GitHub Copilot (`copilot --acp`), Kimi CLI, Qwen Code, Gemini CLI, and any ACP-compliant agent |

The **ACP adapter** is the universal protocol layer that standardizes communication with any agent supporting the [Agent Client Protocol](https://github.com/cloga/optimus-code/issues/319). It uses JSON-RPC over stdio with LSP-style `Content-Length` framing, replacing legacy CLI text parsing with structured session lifecycle messages (`initialize` → `session/new` → `session/prompt` → `session/update` → response).

To configure an ACP-based agent for all projects by default, add an entry to `~/.optimus/config/available-agents.json` (or `OPTIMUS_USER_AVAILABLE_AGENTS_PATH`). If a repository needs its own override, copy `.optimus/config/available-agents.project.sample.json` to `.optimus/config/available-agents.json` and edit it there:

```json
{
  "id": "qwen-acp",
  "name": "Qwen Code (ACP)",
  "adapter": "acp",
  "executable": "qwen",
  "args": ["--acp"],
  "enabled": true
}
```

Other examples:

```json
{ "id": "copilot-acp", "name": "Copilot (ACP)", "adapter": "acp", "executable": "copilot", "args": ["--acp"], "enabled": true }
{ "id": "gemini-acp", "name": "Gemini CLI (ACP)", "adapter": "acp", "executable": "gemini", "args": ["--acp"], "enabled": true }
```

### Engine/Model Resolution

When delegating a task, engine and model are resolved in priority order:
1. Master-provided `role_engine` / `role_model`
2. T2 role frontmatter `engine` / `model`
3. `available-agents.json` (first non-demo engine)
4. Hardcoded fallback: `claude-code`

### Multi-Engine Configuration

The default engine registry lives in `~/.optimus/config/available-agents.json`. Project-level `.optimus/config/available-agents.json` is optional and only needed when a repository should override the user-level defaults. The `protocol` field determines which adapter handles the engine:

Optimus resolves engine settings in three layers: built-in defaults, then the user-level `~/.optimus/config/available-agents.json` (or `OPTIMUS_USER_AVAILABLE_AGENTS_PATH`), then the project-level `.optimus/config/available-agents.json` if you explicitly opt into a repository-specific override. Nested objects merge deeply, while arrays such as `available_models` or capability lists are replaced instead of concatenated.

During migration, `optimus upgrade --disable-project-available-agents` disables the active project override without deleting it, which is useful when you want to standardize on the user-level registry across repositories.

```json
{
  "engines": {
    "claude-code": {
      "protocol": "auto",
      "preferred_protocol": "acp",
      "available_models": ["claude-opus-4.6-1m"],
      "cli_flags": "--model",
      "automation": { "mode": "auto-approve" },
      "timeout": { "heartbeat_ms": 600000, "activity_ms": 1200000 },
      "acp": {
        "path": "claude-agent-acp",
        "cli_flags": "--model",
        "capabilities": { "automation_modes": ["auto-approve"] }
      },
      "cli": {
        "path": "claude",
        "cli_flags": "--model",
        "capabilities": { "automation_modes": ["interactive", "plan", "accept-edits", "deny-unapproved", "auto-approve"] }
      }
    },
    "github-copilot": {
      "protocol": "cli",
      "path": "copilot",
      "available_models": ["gemini-3-pro-preview", "gpt-5.4"],
      "cli_flags": "-m",
      "automation": { "mode": "auto-approve", "continuation": "autopilot", "max_continues": 8 },
      "timeout": { "heartbeat_ms": 600000 }
    },
    "qwen-code": {
      "protocol": "acp",
      "path": "auto",
      "args": ["--acp"],
      "available_models": ["qwen3-coder"],
      "cli_flags": "--model",
      "timeout": { "heartbeat_ms": 600000 }
    }
  }
}
```

When `protocol` is set to `auto`, Optimus evaluates the requested `automation.mode` and `automation.continuation` against each configured transport's declared capabilities, then selects the first compatible protocol in the preferred order.

To inspect the resolved behavior directly, use `explain_available_agents`. This returns the requested automation policy, each candidate transport, the selected protocol, and the fallback reason when a preferred transport is rejected.

- **`cli`** (default) — Text-based structured output via CLI (Claude Code, GitHub Copilot)
- **`acp`** — JSON-RPC 2.0 over NDJSON stdio (Qwen Code, and any future ACP-compliant agent)
- **`auto`** — Choose ACP or CLI at runtime based on the declared automation intent and transport capabilities
- **`timeout.heartbeat_ms`** — Engine-level heartbeat timeout (default: 10 min). Tasks with no heartbeat update beyond this threshold are marked failed. Can be overridden per-task via `heartbeat_timeout_ms` on `delegate_task_async`.

### ACP vs Autopilot

Do not conflate **ACP** with **autopilot**:

- **ACP** is a transport protocol. In Optimus config it belongs to `protocol`, `preferred_protocol`, and transport blocks such as `acp.path`.
- **`autopilot`** is a Copilot continuation policy. In Optimus config it belongs to `automation.continuation`, not `protocol`.
- `auto-approve` controls approval behavior. `autopilot` controls whether Copilot keeps spending additional turns to continue the task.

For GitHub Copilot specifically, the official docs separate these concerns too:

- **Copilot CLI via ACP** is documented as a **public preview** server mode started with `copilot --acp`.
- **Copilot autopilot** is documented as a CLI execution mode that keeps iterating until completion, typically combined with `--allow-all` and optionally `--max-autopilot-continues`.

One practical nuance: the top-level `copilot --help` output may only show `--acp`, while the official ACP reference documents additional ACP server options such as `--stdio` and `--port`. Treat the GitHub ACP reference as the source of truth for Copilot ACP transport details rather than inferring capability limits from the summary help text alone.

### Automation Policy

`automation.mode` is an intent enum. Do not write raw vendor strings like `dontAsk`, `bypassPermissions`, or `autopilot` into new configs.

- **`interactive`** — Use the vendor default approval flow
- **`plan`** — Read-only planning mode
- **`accept-edits`** — Auto-approve edits while keeping command side effects guarded where supported
- **`deny-unapproved`** — Never ask interactively; reject tools unless pre-approved
- **`auto-approve`** — Run autonomously by auto-approving or bypassing permission prompts where supported

`automation.continuation` is separate from approval policy:

- **`single`** — Execute one agent run without automatic continuation
- **`autopilot`** — Enable Copilot CLI autopilot continuation when supported

Legacy aliases such as `dontAsk`, `bypassPermissions`, and `autopilot` are still parsed for backward compatibility, but new configs should use the normalized enum values above.

To add a new ACP vendor, just add an entry with `"protocol": "acp"` — zero code changes required.

### Skill Pre-Flight

If `required_skills` is specified, the system verifies all skills exist before execution. Missing skills cause a rejection with actionable error — Master creates them via `skill-creator`, then retries.

### Hybrid SDLC

- **Local AI Blackboard**: Agents use `.optimus/` markdown files for drafting, debating, and long-term memory.
- **GitHub Integration**: All Issues/PRs auto-tagged with `[Optimus]` prefix and `optimus-bot` label for traceability.

---

## Alternative: Global Install

```bash
npm install -g github:cloga/optimus-code
optimus init
optimus serve
```

## CLI Reference

```
optimus init        Bootstrap .optimus/ workspace in current directory
optimus serve       Start MCP server (stdio transport)
optimus upgrade [--disable-project-available-agents]
                    Update skills, roles, and config to latest version
                    (preserves agents and runtime data)
optimus version     Print version
optimus help        Show help
```

---

## Example Prompts

Once configured, try these in your AI coding tool:

- *"Run roster_check to see what agents are available."*
- *"Use dispatch_council to have the Chief Architect and QA Engineer review our design."*
- *"Delegate to the PM to create a GitHub Issue for the auth refactor."*

---

> *Stop prompting. Start orchestrating.*
