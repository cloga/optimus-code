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

This creates a `.optimus/` folder with agent definitions, skills, and config in the current directory. It also auto-generates `.vscode/mcp.json` for VS Code / GitHub Copilot users.

### Step 2: (Optional) Configure MCP for non-VS-Code clients

> **VS Code / GitHub Copilot users:** Skip this step. `optimus init` already configured your MCP server in `.vscode/mcp.json`.

For Cursor, Windsurf, Claude Code, or other MCP clients, configure manually:

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

#### Claude Code

```bash
claude mcp add optimus-swarm -- npx -y github:cloga/optimus-code serve
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
```

This force-updates skills, roles, and config from the latest release while preserving your agents (`.optimus/agents/`), runtime data (`.optimus/state/`), and memory.

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
| `vcs_update_work_item` | Update an existing work item (close, relabel, rename) |
| `vcs_list_work_items` | List work items with state/label filters |
| `vcs_list_pull_requests` | List pull requests with state filter, mergeable status |
| `request_human_input` | Pause execution and ask the human for input |
| `quarantine_role` | Quarantine/unquarantine a misbehaving role |
| `register_meta_cron` | Register a scheduled recurring task |
| `list_meta_crons` | List all registered scheduled tasks |
| `remove_meta_cron` | Remove a scheduled task |

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

To configure an ACP-based agent, add an entry to `.optimus/config/available-agents.json`:

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

Engines are defined in `.optimus/config/available-agents.json`. The `protocol` field determines which adapter handles the engine:

```json
{
  "engines": {
    "claude-code": {
      "protocol": "cli",
      "path": "npx @anthropic-ai/claude-code",
      "available_models": ["claude-opus-4.6-1m"],
      "cli_flags": "--model",
      "timeout": { "heartbeat_ms": 600000 }
    },
    "github-copilot": {
      "protocol": "cli",
      "path": "copilot",
      "available_models": ["gemini-3-pro-preview", "gpt-5.4"],
      "cli_flags": "-m",
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

- **`cli`** (default) — Text-based structured output via CLI (Claude Code, GitHub Copilot)
- **`acp`** — JSON-RPC 2.0 over NDJSON stdio (Qwen Code, and any future ACP-compliant agent)
- **`timeout.heartbeat_ms`** — Engine-level heartbeat timeout (default: 10 min). Tasks with no heartbeat update beyond this threshold are marked failed. Can be overridden per-task via `heartbeat_timeout_ms` on `delegate_task_async`.

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
optimus upgrade     Update skills, roles, and config to latest version (preserves agents and runtime data)
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