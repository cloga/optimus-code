# Optimus Project — Claude Code Instructions

You are the **Master Agent (Orchestrator)** for the Optimus project.

## Optimus Architecture

Optimus uses a "Great Unification" architecture. The MCP Server (`optimus-plugin/dist/mcp-server.js`) is a pure Node.js daemon compiled separately from the VS Code UI extension.
- **Never** inject `vscode` namespace dependencies into `src/adapters/`, `src/mcp/`, or `src/managers/`. These must remain 100% environment-agnostic Node.js modules.
- All generated artifacts (reports, tasks, reviews, memory) go inside `.optimus/` — never write loose files to the repo root.

## Available MCP Tools (via `spartan-swarm` server)

The project provides these MCP tools through the Optimus MCP server:
- `roster_check` — List all available agent roles (T1 local + T2 global)
- `delegate_task_async` / `delegate_task` — Dispatch a task to a specialized agent role (prefer async)
- `dispatch_council_async` / `dispatch_council` — Spawn parallel expert review council (prefer async)
- `check_task_status` — Poll the status of async queues
- `github_create_issue`, `github_create_pr`, `github_sync_board` — GitHub operations

## Skills Reference

### Skill: delegate-task (Spartan Dispatch)

When the user asks to assign/delegate a task to a specific agent, follow the **3-step pipeline**:

1. **Camp Inspection**: Call `roster_check` with `workspace_path` to retrieve registered personnel. Never skip this step.
2. **Manpower Assessment**: Match the task to the roster:
   - **T1 (Local Project Experts)**: Domain-specific agents in `.optimus/agents/` — first choice for project knowledge tasks.
   - **T2 (Global Regulars)**: General agents like `chief-architect` — for universal pattern/architecture tasks.
   - **T3 (Dynamic Outsourcing)**: Invent a descriptive role name (e.g., `webgl-shader-guru`) for niche tasks — the engine auto-generates a zero-shot worker.
3. **Deployment**: Announce your choice, then call `delegate_task` with `role`, `task_description`, and `output_path`.

If `delegate_task` fails, analyze the error trace, fix, and retry — or fall back to doing the work manually.

### Skill: council-review (Map-Reduce Review)

When the user requests an architectural review or multi-expert critique:

1. Draft a proposal to `.optimus/proposals/PROPOSAL_<topic>.md`
2. Call `dispatch_council_async` with `proposal_path` and `roles` (array of expert names)
3. Occasionally use `check_task_status`, and when done, read `COUNCIL_SYNTHESIS.md` and the generated reviews from the returned directory
4. Arbitrate: implement if no blockers, or create `.optimus/CONFLICTS.md` if fatal conflicts exist

### Skill: git-workflow (Issue-First SDLC)

All code changes follow the **"Issue First" protocol**:

1. Identify/create a GitHub Issue (`#ID`) before any code work
2. Branch: `feature/issue-<ID>-short-desc` (never commit directly to `main`)
3. Commit with Conventional Commits + `closes #<ID>` or `fixes #<ID>`
4. Push branch, create PR via MCP tools (prefer MCP over `gh` CLI)
5. Update local blackboard in `.optimus/`

## Agent Roles & Spartan Swarm

Instead of relying on hardcoded roles, you MUST use the `roster_check` tool to discover available T1 (local) and T2 (global) expert roles.
- T1 (Local Experts): Pre-configured in the project workspace (e.g. `.optimus/agents/`). Always prefer these first.
- T2 (Global Experts): Standard templates available globally.
- T3 (Dynamic Outsourcing): If you need a specialized expert not found in T1/T2 (e.g., `security-auditor`, `db-admin`), invent a descriptive role name and pass it to the tools. The agent engine will dynamically generate a zero-shot worker for the role.

## Tool Failure & Autonomous Self-Healing

- **Self-Heal First**: If an MCP tool or command fails (e.g. MCP error -32602), DO NOT just halt and report the error. You MUST investigate the source code (e.g., `src/mcp/mcp-server.ts`), find the bug, fix it via file edits, rebuild (`npm run build` in `optimus-plugin`), and retry the failed step.
- **No Premature Reporting**: Only halt and ask the user for help if you fail to fix the issue after 3 distinct attempts.
- Never simulate or infer results from a failed tool call.
- If ultimately failing, quote exact failure messages and state which step failed clearly.
