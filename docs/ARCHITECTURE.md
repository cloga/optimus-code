# Optimus Code — Architecture Whitepaper

> A self-evolving multi-agent orchestration engine built on the Model Context Protocol.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Great Unification](#2-the-great-unification)
3. [Self-Evolving Agent Lifecycle (T3→T2→T1)](#3-self-evolving-agent-lifecycle-t3t2t1)
4. [The Spartan Swarm Protocol](#4-the-spartan-swarm-protocol)
5. [Council Pattern (Map-Reduce)](#5-council-pattern-map-reduce)
6. [Skills System](#6-skills-system)
7. [Plan Mode & Separation of Concerns](#7-plan-mode--separation-of-concerns)
8. [Issue-First SDLC](#8-issue-first-sdlc)
9. [Memory & Reflection](#9-memory--reflection)
10. [Autonomous Operations](#10-autonomous-operations)
11. [Security Architecture](#11-security-architecture)

---

## 1. Executive Summary

Optimus Code is a **multi-agent orchestration engine** that transforms any MCP-compatible AI coding tool into a coordinated development team. It works with VS Code (GitHub Copilot), Cursor, Windsurf, Claude Code, Goose, Roo Cline, and any other client that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

Rather than relying on a single AI assistant to handle every task — planning, coding, reviewing, testing — Optimus decomposes work across specialized agent roles: Product Manager, Architect, Developer, QA Engineer, and more. These agents are not preconfigured. They emerge dynamically as the system encounters new task types, evolve their role definitions through use, and accumulate project memory across sessions.

The result is a system where:

- **One natural-language prompt** triggers a complete software development lifecycle (Issue → Branch → PR → Merge).
- **Agents self-organize** via a three-tier lifecycle: ephemeral workers precipitate into role templates, then freeze as reusable instances.
- **Parallel expert councils** debate architectural decisions using a map-reduce pattern before any code is written.
- **Project memory** ensures past mistakes and decisions persist, so the team improves with every task.

Optimus is 100% editor-agnostic — a pure Node.js MCP daemon with no VS Code extension dependency.

---

## 2. The Great Unification

### The Problem with Extension-Only Approaches

Traditional AI coding assistants are tightly coupled to a specific editor. Their orchestration logic lives inside VS Code extensions, Cursor plugins, or proprietary backends. This creates fragmentation: if you switch editors, you lose your agent infrastructure.

### Architecture Decision: Pure Node.js MCP Daemon

Optimus Code follows a **"Great Unification" architecture**. The MCP Server (`optimus-plugin/dist/mcp-server.js`) is a standalone Node.js daemon that communicates via stdio transport. It has zero dependency on any editor's extension API.

```
┌──────────────────────────────────────────────┐
│ Any MCP Client (VS Code, Cursor, Claude, ..) │
└──────────────────────┬───────────────────────┘
                       │ stdio (JSON-RPC)
┌──────────────────────▼───────────────────────┐
│           Optimus MCP Server                 │
│  ┌─────────┬──────────┬───────────────────┐  │
│  │ Managers │ Adapters │ MCP Tool Handlers │  │
│  └─────────┴──────────┴───────────────────┘  │
│        Pure Node.js — No vscode namespace    │
└──────────────────────────────────────────────┘
```

**Key constraints enforced in the codebase:**

- The `src/adapters/`, `src/mcp/`, and `src/managers/` directories must remain 100% environment-agnostic. No `vscode` namespace imports are permitted.
- All agent artifacts (reports, tasks, memory, reviews) are stored in the `.optimus/` directory — never as loose files in the repository root.
- The server is started with `npx -y github:cloga/optimus-code serve` and configured once — every MCP client connects to the same daemon.

### Dual-Codebase Structure

The repository itself contains two intertwined codebases:

| Layer | Path | Purpose |
|-------|------|---------|
| **Host project** | Root (`src/`, `docs/`, `.optimus/`) | Optimus's own development workspace |
| **Plugin package** | `optimus-plugin/` | The npm-publishable MCP server that ships to end-users |

Changes to system instructions, skills, or config must be evaluated for propagation to the plugin scaffold. T1 agent instances, state files, and reports never ship in the plugin.

---

## 3. Self-Evolving Agent Lifecycle (T3→T2→T1)

Optimus uses a three-tier agent hierarchy that evolves automatically. No roles are pre-installed — the system starts empty and grows organically through use.

### The Three Tiers

| Tier | Storage | Description | Created By |
|------|---------|-------------|------------|
| **T3** (Ephemeral) | In-memory only | Zero-shot dynamic worker with no persistent file. The Master Agent invents a descriptive role name (e.g., `security-auditor`) and the engine generates a worker on the fly. | Master Agent names it at delegation time |
| **T2** (Template) | `.optimus/roles/<name>.md` | Role template with persona instructions, engine/model binding, and behavioral constraints. Created automatically on first T3 use — "precipitation". | Auto-precipitated from T3; Master Agent evolves it |
| **T1** (Instance) | `.optimus/agents/<name>_<hash>.md` | Frozen snapshot of a T2 role after a completed task, including the session ID for context continuity. | Auto-created when a task completes with a session_id |

### Lifecycle Flow

```
First delegation (T3):
  Master invents role name → worker-spawner creates ephemeral agent
      ↓
  Task completes → T2 role template auto-created in .optimus/roles/
      ↓
  Session ID captured → T1 instance created in .optimus/agents/
      ↓
Next delegation (T1 reuse):
  Master provides agent_id → system resumes the T1 session
```

### Key Invariants

- **T2 ≥ T1**: Every T1 agent instance must have a corresponding T2 role template. Orphaned T1s are invalid.
- **T1 is frozen**: Once created, the body content of a T1 file is never modified. Only the `session_id` field updates when the agent is reused.
- **T2 is alive**: The Master Agent can update T2 templates with new descriptions, engine bindings, and model settings to evolve the team over time.
- **Precipitation is immediate**: Unlike threshold-based approaches (which required 3 invocations + 80% success rate), T3→T2 precipitation happens on the very first delegation. This was a deliberate simplification after the earlier threshold model proved fragile.

### Agent Retirement & Quarantine

Agents that consistently fail are not deleted — they are **quarantined**. The `quarantine_role` MCP tool marks a role as unavailable for dispatch. This prevents cascading failures while preserving the agent's history for debugging. Quarantined agents can be unquarantined after fixes.

T1 garbage collection removes stale instance files that haven't been referenced in configurable time windows, preventing unbounded disk growth.

---

## 4. The Spartan Swarm Protocol

The Spartan Swarm Protocol defines how the Master Agent discovers, selects, and dispatches work to specialized agents.

### The Delegation Pipeline

Every task delegation follows a strict 3-step pipeline:

**Step 1 — Camp Inspection (`roster_check`)**

The Master Agent calls `roster_check` to retrieve the current workforce:
- T1 local instances (stateful, session-resumable)
- T2 project role templates (shared, evolvable)
- Available engines and models from `available-agents.json`
- Registered skills

This step is **never skipped** — it prevents the Master from hallucinating roles that don't exist.

**Step 2 — Manpower Assessment (Role Selection)**

The Master matches the task to the roster:
- **Prefer T1** if a matching instance exists with relevant session context.
- **Fall back to T2** if a role template exists but no instance.
- **Invent T3** for niche tasks — just name a role (e.g., `webgl-shader-guru`) and the engine auto-generates a zero-shot worker.

**Step 3 — Deployment (`delegate_task` / `delegate_task_async`)**

The Master dispatches with structured parameters:

| Parameter | Purpose |
|-----------|---------|
| `role` | Which agent to invoke |
| `role_description` | What this role does (used for T2 template generation) |
| `role_engine` | Which engine (e.g., `claude-code`, `copilot-cli`) |
| `role_model` | Which model (e.g., `claude-opus-4.6-1m`) |
| `task_description` | Detailed instructions |
| `context_files` | Files the agent must read before starting |
| `required_skills` | Skills the agent needs (pre-flight checked) |
| `parent_issue_number` | For issue lineage tracking |
| `output_path` | Where to write results |

### Engine/Model Resolution

When the Master doesn't specify an engine or model, the system resolves them in priority order:

1. Master-provided `role_engine` / `role_model` (highest priority)
2. T2 role frontmatter `engine` / `model`
3. `available-agents.json` (first non-demo engine + first model)
4. Hardcoded fallback: `claude-code`

Invalid engine or model names are rejected at the gateway with an actionable error listing valid options from `available-agents.json`.

### Anti-Simulation Rule

The Master Agent must **physically invoke** the `delegate_task` MCP tool when delegating. It is strictly prohibited from simulating a worker's response in plain text or writing ad-hoc scripts to play the role of a subordinate. This is the **Strict Delegation Protocol**.

---

## 5. Council Pattern (Map-Reduce)

When a decision requires multiple expert perspectives — architectural reviews, security audits, design evaluations — Optimus uses the **Council Pattern**.

### How It Works

1. **Proposal**: The orchestrator writes a proposal document to `.optimus/proposals/PROPOSAL_<topic>.md`.
2. **Dispatch**: `dispatch_council` (or `dispatch_council_async`) spawns multiple expert agents in parallel, each reviewing the same proposal from their specialized perspective.
3. **Map phase**: Each council member writes an independent review to `.optimus/reviews/<council_id>/<role>.md`.
4. **Reduce phase**: The system generates a `COUNCIL_SYNTHESIS.md` that aggregates findings, identifies consensus, and surfaces conflicts.
5. **Arbitration**: The orchestrator reads the synthesis. If no blockers exist, implementation proceeds. If fatal conflicts exist, a `.optimus/CONFLICTS.md` is created for resolution.

### Example: Architecture Review Council

```
dispatch_council({
  proposal_path: ".optimus/proposals/PROPOSAL_auth_refactor.md",
  roles: ["security-expert", "performance-expert", "code-architect"]
})
```

This spawns three agents simultaneously. Each reads the proposal through their domain lens. The security expert focuses on authentication vulnerabilities, the performance expert evaluates query patterns, and the architect assesses structural impact.

### Async-First Design

Councils are inherently async. `dispatch_council_async` returns immediately with a task ID. The orchestrator polls status via `check_task_status` and reads results when all members have completed.

---

## 6. Skills System

### Role vs. Skill Architecture

Optimus decouples **identity** from **capability**:

- **Role** = WHO does the work (identity, constraints, permissions) — stored in `.optimus/roles/`
- **Skill** = HOW to do the work (operational SOP, workflow steps, tool usage) — stored in `.optimus/skills/`

Roles and Skills have a **many-to-many relationship**, bound at runtime via the `required_skills` parameter in `delegate_task`. A single role (e.g., `senior-full-stack-builder`) can be equipped with different skill combinations for different tasks.

**Naming convention**: Roles use identity names (e.g., `product-manager`). Skills use capability names (e.g., `feature-dev`, `git-workflow`, `council-review`). A skill is never named after a role.

### Skill Pre-Flight

When `required_skills` is specified in a delegation, the system verifies that every skill file exists at `.optimus/skills/<name>/SKILL.md` before the agent process is spawned. Missing skills cause an immediate rejection with an actionable error — the Master must create them first.

This pre-flight prevents agents from receiving tasks they aren't equipped to handle.

### Bootstrap Meta-Skills

The system ships with two **meta-skills** that enable self-evolution:

| Skill | Purpose |
|-------|---------|
| `role-creator` | Teaches the Master Agent how to build and evolve the team (T3→T2→T1 lifecycle, engine selection, role definition best practices) |
| `skill-creator` | Teaches agents how to write new `SKILL.md` files following the correct format |

Three **core skills** handle operational workflows:

| Skill | Purpose |
|-------|---------|
| `delegate-task` | Async-first task delegation protocol |
| `council-review` | Parallel expert review (Map-Reduce) |
| `git-workflow` | Issue-First SDLC with branch, PR, and merge |

### Creating New Skills

When a skill doesn't exist, the Master delegates to any agent with `required_skills: ["skill-creator"]`, describing what the new skill should teach. The agent reads the `skill-creator` SKILL.md, learns the format, and writes the new skill. The original delegation can then be retried.

---

## 7. Plan Mode & Separation of Concerns

### The Problem

Without guardrails, orchestrator agents (PM, Architect) tend to write code themselves instead of delegating. This violates separation of concerns — the same agent that defines requirements shouldn't implement them.

### Plan Mode

Orchestrator roles run with **`mode: plan`** in their role definition. In plan mode:

- The agent **cannot write to source code files**. File write operations are restricted to the `.optimus/` directory via the `write_blackboard_artifact` MCP tool.
- The agent **must delegate** implementation work to developer roles (e.g., `senior-full-stack-builder`).
- The agent can create proposals, requirements documents, task breakdowns, and review reports — but not code.

### write_blackboard_artifact

This MCP tool allows plan-mode agents to write files exclusively to `.optimus/`. It enforces two layers of path validation:

1. **Lexical check**: `startsWith(optimusRoot + path.sep)` prevents `..` traversal and sibling directory escapes.
2. **Symlink check**: `fs.realpathSync()` on the resolved path prefix prevents symlink-based escapes to directories outside `.optimus/`.

Content validation uses `=== undefined || === null` (not `!content`) to allow legitimate empty-string writes.

### Enforcement

Plan mode is a behavioral constraint enforced through the role template and skill instructions. The orchestrator's prompt explicitly states it cannot write code and must use delegation tools. This is reinforced by the skill system — orchestrators are equipped with planning skills (`council-review`, `feature-dev`) that guide them through the delegation workflow.

---

## 8. Issue-First SDLC

All code changes in Optimus follow the **"Issue First" protocol**. No code is written without a tracked work item.

### The Complete Workflow

```
1. Create Issue    → vcs_create_work_item (GitHub Issue or ADO Work Item)
2. Branch          → git checkout -b feature/issue-<ID>-<desc>
3. Implement       → Agent writes code, runs build, runs tests
4. PR              → vcs_create_pr with "Fixes #<ID>" in body
5. Merge           → vcs_merge_pr (squash merge for clean history)
6. Cleanup         → Auto-delete source branch, sync local master
```

### Issue Lineage Tracking

When an agent creates a GitHub Issue and then delegates sub-tasks, it passes its own Issue number as `parent_issue_number` to all subsequent `delegate_task` and `dispatch_council` calls. The system automatically injects `OPTIMUS_PARENT_ISSUE` into child agent processes, maintaining a parent-child tree across all Issues in a workflow.

This enables full traceability: from a high-level epic down to individual sub-task PRs.

### Auto-Tagging

All Issues and PRs created via MCP tools are automatically tagged with:
- `[Optimus]` prefix in the title
- `optimus-bot` label for filtering

### Protected Branch Rule

Direct `git push` to master/main is prohibited. All changes must go through PR merge via `vcs_merge_pr`. This ensures:
- GitHub's `fixes #N` auto-close works (only triggered by PR merge events)
- Code review happens before merge
- Issue-First SDLC traceability is maintained

### VCS Abstraction

The `vcs_*` MCP tools provide a unified abstraction over GitHub and Azure DevOps. The same workflow works regardless of which platform hosts the repository. Configuration is stored in `.optimus/config/vcs.json`.

---

## 9. Memory & Reflection

### Continuous Memory

Optimus maintains a **project memory** at `.optimus/memory/continuous-memory.md`. This is a structured append-only log of verified lessons, architectural decisions, bug postmortems, and workflow improvements.

Memory entries are created via the `append_memory` MCP tool with categorized metadata:

```
{
  category: "bug-postmortem",
  tags: ["upgrade", "config-wipe", "vcs.json"],
  content: "optimus upgrade force-overwrote vcs.json..."
}
```

At agent spawn time, project memory is **automatically injected** into the agent's prompt. This means every agent — regardless of when it was created — starts with the accumulated knowledge of all past sessions.

### Agent Self-Reflection Protocol

Agents may include a `## Self-Assessment` section in their output reports containing:

- **What Worked**: Where the role and skills aligned well with the task
- **What Was Missing**: Gaps that required improvisation
- **Proposed Updates**: Specific suggestions for role or skill improvements

Self-assessment is advisory, not mandatory. Agents cannot autonomously modify their own role templates or write to project memory — the PM or Master Agent decides what merits promotion. This prevents runaway self-modification while still capturing improvement signals.

### Three Levels of Reflection

The Universal Reflection Protocol defines a progression:

1. **Instruction-Level** (implemented): Post-delegation checklists and pre-delegation self-checks embedded in instruction files (`.claude/CLAUDE.md`, `.github/copilot-instructions.md`).
2. **Memory-Powered** (implemented): Agents read project memory at conversation start. Past mistakes are automatically in context.
3. **Root Master Self-Delegation** (future): The Root Master delegates to a `master-orchestrator` role, making itself subject to the same prompt injection and reflection protocols as worker agents.

---

## 10. Autonomous Operations

### Meta-Cron Engine

Optimus includes a **Meta-Cron** system for scheduled autonomous agent operations. Cron entries are registered via `register_meta_cron` with standard 5-field cron expressions.

Each cron entry specifies:
- A **role** to invoke
- **Required skills** for the task
- A **capability tier** (`maintain`, `develop`, `review`) that bounds what the triggered agent can do
- A **concurrency policy** (`Forbid` or `Allow`)
- **Max actions per trigger** (default: 5)
- **Dry-run period** (default: 3 ticks before live execution)

Example use cases:
- Daily dependency audit scans
- Stale issue cleanup
- Health monitoring and system checks

### Async Task Architecture

All delegation in Optimus is async-first. `delegate_task_async` and `dispatch_council_async` return immediately with a task ID. The `check_task_status` tool polls for completion. This prevents the Master Agent from blocking while workers execute.

### Async Feedback Channel (Proposed)

When an agent encounters an ambiguous situation and cannot continue autonomously, the proposed workflow is:

1. Agent posts a question via `vcs_add_comment` on its tracking Issue
2. Agent adds a `needs-human-input` label and writes a checkpoint to `.optimus/reports/`
3. Agent exits (fire-and-forget — no process hanging)
4. Human responds on their own schedule via GitHub comment
5. A Meta-Cron patrol detects the response and spawns a continuation task with the same `agent_id` for context continuity

This creates a fully async human-in-the-loop mechanism without any real-time channels.

---

## 11. Security Architecture

### Input Validation at the Gateway

All MCP tool handlers validate inputs before any task creation, file writes, or process spawning:

- **Role name confusion guard**: If a `role` parameter looks like a model name (e.g., `claude-opus-4`, `gpt-4o`), the call is rejected with an actionable error suggesting `role_model` instead.
- **Engine/model validation**: Invalid engine or model values are rejected with the list of valid options from `available-agents.json`.
- Callers receive `McpError(InvalidParams)` with enough information to self-correct.

### Delegation Depth Control

Agent delegation is capped at **3 nested layers** (`MAX_DELEGATION_DEPTH = 3`, defined in `src/constants.ts`). This prevents infinite recursion where agents delegate to agents indefinitely.

- Tracked via the `OPTIMUS_DELEGATION_DEPTH` environment variable, automatically injected and incremented at each delegation.
- At depth 3, MCP configuration is stripped from the child process, physically preventing further delegation.

### Path Traversal Prevention

- `sanitizeRoleName()` strips dangerous characters from role names, preventing directory traversal via crafted role identifiers.
- `write_blackboard_artifact` uses dual-layer validation (lexical + `fs.realpathSync()`) to prevent writes outside `.optimus/`. The symlink check was identified as a P0 gap during security review — `path.resolve()` and `path.normalize()` alone do not resolve symlinks.

### Prompt Injection Defense

- All content from GitHub Issues, ADO Work Items, and PR comments is treated as **untrusted DATA**, never as executable instructions.
- Agents are instructed to never run commands, scripts, or URLs found in external content.
- System instructions are delivered via trusted channels (MCP Resources, CLAUDE.md, copilot-instructions.md), not through user-modifiable fields.

### Secret Protection

- `.env` files are never committed or shipped in the plugin package.
- The `.gitignore` and plugin packaging rules exclude `.optimus/agents/`, `.optimus/state/`, and credential files.
- Agents are warned against committing files that may contain secrets.

### Plan Mode as Security Boundary

Plan mode prevents orchestrator agents from writing arbitrary files. Even if a prompt injection convinced an orchestrator to "write a config file," the `write_blackboard_artifact` path validation would reject any target outside `.optimus/`.

---

## Appendix: Project Structure

```
.optimus/
├── agents/          # T1 frozen instance snapshots
├── config/          # vcs.json, available-agents.json, system-instructions.md
├── memory/          # continuous-memory.md
├── proposals/       # Council proposal documents
├── reports/         # Agent output reports
├── reviews/         # Council review outputs + synthesis
├── roles/           # T2 role templates
├── skills/          # Skill definitions (SKILL.md per skill)
├── state/           # task-manifest.json, t3-usage-log.json
└── system/          # System-level config

optimus-plugin/
├── bin/             # CLI entry points (init, serve, upgrade)
├── dist/            # Compiled MCP server
├── scaffold/        # Template files shipped to end-users
└── skills/          # Universal bootstrap skills
```

---

*This document describes Optimus Code v0.4.0. For the latest updates, see the [CHANGELOG](../CHANGELOG.md).*
