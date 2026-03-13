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
| `vcs_create_work_item` | Create a work item (GitHub Issue / ADO Work Item) via unified VCS abstraction |
| `vcs_create_pr` | Create a Pull Request via unified VCS abstraction |
| `vcs_merge_pr` | Merge a Pull Request via unified VCS abstraction |
| `vcs_add_comment` | Add a comment to a work item or PR (requires `item_type`) |
| `github_update_issue` | Update an existing GitHub Issue |
| `github_sync_board` | Sync open issues to local TODO board |

### delegate_task Extended Parameters

| Parameter | Required | Description |
|---|---|---|
| `role` | ✅ | Role name (e.g., `security-auditor`) |
| `role_description` | | What this role does — used to generate T2 template |
| `role_engine` | | Which engine (e.g., `claude-code`, `copilot-cli`) |
| `role_model` | | Which model (e.g., `claude-opus-4.6-1m`) |
| `task_description` | ✅ | Detailed task instructions |
| `output_path` | ✅ | Where to write results |
| `workspace_path` | ✅ | Project root path |
| `context_files` | | Files the agent must read |
| `required_skills` | | Skills the agent needs (pre-flight checked) |

---

## Features

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

### Engine/Model Resolution

When delegating a task, engine and model are resolved in priority order:
1. Master-provided `role_engine` / `role_model`
2. T2 role frontmatter `engine` / `model`
3. `available-agents.json` (first non-demo engine)
4. Hardcoded fallback: `claude-code`

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