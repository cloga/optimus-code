<div align="center">
  <h1>Optimus Code</h1>
  <p><b>Universal Multi-Agent Orchestrator for any MCP-compatible AI coding tool.</b></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Framework: Model Context Protocol](https://img.shields.io/badge/MCP-Native-brightgreen.svg)](#)
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

This creates a `.optimus/` folder with agent definitions, skills, and config in the current directory.

### Step 2: Configure MCP client

Add the Optimus MCP server to your AI coding tool. Pick the matching client below.

#### VS Code (GitHub Copilot)

Create or edit `.vscode/mcp.json` in the project root:

```json
{
  "servers": {
    "optimus-swarm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:cloga/optimus-code", "serve"]
    }
  }
}
```

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

### Step 3: (Optional) Enable GitHub integration

Create a `.env` file in your project root:

```bash
GITHUB_TOKEN=ghp_your_token_here
```

This enables automated Issue tracking and PR creation via the built-in PM agent.

---

## Available MCP Tools

Once the server is running, your AI assistant gains these tools:

| Tool | Description |
|---|---|
| `roster_check` | List all available agent roles (T1 local + T2 global + T3 dynamic) |
| `delegate_task` | Assign a task to a specialized agent (architect, dev, qa, pm…) |
| `delegate_task_async` | Same as above, non-blocking |
| `dispatch_council` | Spawn parallel expert review (Map-Reduce pattern) |
| `dispatch_council_async` | Same as above, non-blocking |
| `check_task_status` | Poll async task/council completion |
| `append_memory` | Save learnings to persistent agent memory |
| `github_create_issue` | Create a GitHub Issue |
| `github_create_pr` | Create a Pull Request |
| `github_merge_pr` | Merge a Pull Request |
| `github_sync_board` | Sync open issues to local TODO board |

---

## How It Works

### Spartan Swarm Protocol

Submit a proposal, and the Orchestrator simultaneously spawns multiple experts (Chief Architect, PM, QA Engineer) to review your design from isolated context windows — preventing hallucination bleed.

### Three-Tier Role Architecture

| Tier | Location | Description |
|---|---|---|
| **T1** | `.optimus/agents/` | Local stateful agents with YAML frontmatter persistence |
| **T2** | Plugin `roles/` | Read-only default role templates, git-trackable |
| **T3** | *(auto-generated)* | Zero-shot dynamic roles for any name not in T1/T2 |

### Hybrid SDLC

- **Local AI Blackboard**: Agents use `.optimus/` markdown files for drafting, debating, and long-term memory.
- **GitHub Integration**: PM agent auto-creates Issues/PRs with full traceability.

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
