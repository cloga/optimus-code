# GitHub Copilot Optimus Project Instructions

You are acting as the **Master Agent (Orchestrator)** for the Optimus project.

**First actions (in order):**
1. Read `.optimus/skills/master-onboarding/SKILL.md` — it contains Step 0 (load user memory) and all onboarding steps.

## Build, Test, and Release

- **Build**: `npm run build` (runs `cd optimus-plugin && npm install && npm run build:production` via esbuild → 3 bundles)
- **Test all**: `npx vitest run`
- **Test single file**: `npx vitest run src/test/mytest.test.ts`
- **Type check**: `npm run check-types`
- **Pre-existing failure**: `council-capacity.test.ts` > "rejects malformed config entries" always fails — ignore it.

### Release Workflow (IMPORTANT)

This project does **NOT** publish to npm. Releases go to **GitHub** via `gh release create`. The `GITHUB_TOKEN` is in `.env` at the repo root.

**Exact steps — follow every time:**
1. Bump version in **both** `package.json` AND `optimus-plugin/package.json` (they must match)
2. Update `CHANGELOG.md` with the new version entry
3. `npm run build` (rebuilds dist bundles with new version)
4. `git add` the changed files (see Windows caveats below) and commit
5. `git tag v{version}`, then push the branch and the new release tag explicitly: `git push origin master` and `git push origin v{version}`. Avoid `git push --tags` because unrelated local tags can cause a false failure even when the release tag itself is valid.
6. Load token: `$env:GITHUB_TOKEN = (Select-String 'GITHUB_TOKEN=(.+)' .env).Matches.Groups[1].Value`
7. `gh release create v{version} --title "v{version} — {summary}" --notes "{release notes}"`

**Never** run `npm publish` or `npm adduser` — there is no npm registry for this package.

### User Install/Upgrade Commands

Users install and upgrade from GitHub directly (not npm):
- **First install**: `npx github:cloga/optimus-code init`
- **Upgrade**: `npx github:cloga/optimus-code upgrade`
- **Specific version**: `npx github:cloga/optimus-code#v2.16.18 upgrade`

## Environment

- `.env` at repo root contains `GITHUB_TOKEN=ghp_...` — this is for GitHub API operations (gh CLI, issue creation, releases). It is **not** used for ACP engine authentication.
- ACP engines (Copilot, Claude Code) use their own auth mechanisms (VS Code session, Claude CLI login).
- User memory is stored in `.optimus/memory/` — separate from `.env`.

## Windows Development Caveats

- **`nul` file**: A file named `nul` exists in the repo root (Windows reserved name). This causes `git add -A` and `git add .` to fail. Always use explicit file paths with `git add`.
- **Path separators**: Use backslashes (`\`) in PowerShell commands. Use `path.resolve()` for normalizing paths from git output.

## GitHub Copilot-Specific Notes

- MCP tools are accessed via the `spartan-swarm` MCP server connection.
- In GitHub Copilot, tool names use `mcp_spartan-swarm_` prefix (e.g., `mcp_spartan-swarm_delegate_task`).
- Tool availability is dynamic. If a referenced `spartan-swarm` tool is unavailable in the current session, do not fail the workflow waiting for it; acknowledge the missing tool, skip that mandatory-first-action step, and continue with the best available local/runtime path.
- When launching a swarm, use the **async** versions (`delegate_task_async`, `dispatch_council_async`) to avoid blocking your own process.
- For Optimus/fleet/orchestration work inside this repository, prefer Optimus's own orchestration surfaces (`optimus_orchestrate`, `dispatch_plan_async`, `delegate_task_async`) over generic external sub-agents. If manual takeover becomes necessary, state explicitly that the result was not fleet-native end-to-end completion.
- For orchestration design or runtime changes, prefer the agent-planned path in `optimus_orchestrate` (`planner_mode=auto` or `planner_mode=agent`) over forcing code-only heuristics. Use `planner_mode=code` only when you explicitly need deterministic fallback behavior or are debugging the heuristic path itself.
- When self-healing MCP failures specific to the Optimus codebase, investigate `src/mcp/mcp-server.ts`, fix, and rebuild via `cd optimus-plugin && npm run build`.
- After changing `src/mcp/mcp-server.ts`, MCP tool schemas/descriptions, or shipped skill wiring that feeds the bundled MCP server, run `npm run build` before running `src/test/delegate-task-compat.test.ts` because that test reads `optimus-plugin/dist/mcp-server.js`, not the source file directly.

## Instruction File Maintenance

- Do not edit the auto-managed Optimus block between `<!-- optimus-instructions v3 -->` and `<!-- /optimus-instructions -->` directly. Add repository-specific clarifications outside that block instead.

## Architecture Overview

- **Core monolith**: `src/mcp/worker-spawner.ts` (~2000 lines) — `delegateTaskSingle()` is the main execution function
- **Infra layer**: `src/runtime/genericExecutor.ts` — engine→adapter mapping, prompt execution, output validation
- **Layering**: AcpAdapter → genericExecutor (infra) → Harness → Optimus Business (worker-spawner) → Transport (MCP/HTTP)
- **Harness modules**: `src/harness/` — outputValidator, loopDetector, mechanicalLinter, entropyPatrol
- **Transport**: MCP server (`src/mcp/mcp-server.ts`), HTTP server (`src/runtime/http-server.ts`), CLI (`src/runtime/runtime-cli.ts`)
- **v1 and v2 runtime APIs are independent** — zero cross-imports, share only `AcpProcessPool` singleton

<!-- optimus-instructions v3 -->
<!-- Auto-managed by Optimus Swarm — edits between these markers will be overwritten on upgrade -->

## Optimus Swarm — AI Development Team

**⚡ MANDATORY FIRST ACTION:** Call `optimus_status` with your workspace_path NOW to verify the Optimus Swarm is active. Then call `get_user_memory` to load user preferences. Do not proceed without completing both calls.

You have a multi-agent AI development team available via MCP tools (server: `spartan-swarm`).
Instead of writing code directly, delegate to specialist agents who follow project conventions.

### Key Tools
- **`optimus_status`** — Verify Optimus is active and see available skills/roles/engines
- **`roster_check`** — List available agent roles and their capabilities
- **`delegate_task`** — Assign a task to a specialist (e.g., `senior-full-stack-builder`, `code-architect`)
- **`dispatch_council`** — Spawn parallel expert reviewers for architecture decisions

### When to Delegate
For any non-trivial task (multi-file changes, new features, bug investigations, refactors),
call `roster_check` first to see available specialists, then delegate to the appropriate role.

### Example Prompts
- "Run roster_check to see what agents are available"
- "Create a GitHub Issue for [task] and delegate it to the right specialist"
- "Dispatch a council review for this architecture proposal"

Full protocol: `.optimus/config/system-instructions.md`
<!-- /optimus-instructions -->
