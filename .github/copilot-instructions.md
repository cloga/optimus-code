# Copilot Instructions for Optimus Code

## Build, Test, and Release

- Build the shipped plugin with `npm run build`. This runs `cd optimus-plugin && npm install && npm run build:production` and regenerates the bundled runtime files under `optimus-plugin/dist/`.
- Type-check with `npm run check-types`.
- Run all tests with `npx vitest run`.
- Run a single test file with `npx vitest run src/test/<name>.test.ts`.
- For runtime, MCP, ACP adapter, worker spawning, or Meta-Cron changes, do not stop at build/type-check. Run targeted tests for the touched area, then run the full Vitest suite when behavior or shared runtime contracts changed.
- After changing `src/mcp/mcp-server.ts`, MCP tool schemas/descriptions, shipped skills, or runtime files consumed by bundled tests, run `npm run build` before compatibility tests because some tests read generated files from `optimus-plugin/dist/`.

## Release Workflow

- This project does not publish to npm. Releases are GitHub releases created from repository tags.
- For a release:
  1. Bump the version in both `package.json` and `optimus-plugin/package.json`; keep them identical.
  2. Update `CHANGELOG.md`.
  3. Run `npm run build`.
  4. Commit through a feature branch and PR; do not push directly to `master`.
  5. Create and push the release tag explicitly, for example `git tag v2.x.y` and `git push origin v2.x.y`.
  6. Create the GitHub release with `gh release create`.
- User upgrade commands install from GitHub, for example `npx github:cloga/optimus-code upgrade` or `npx github:cloga/optimus-code#v2.x.y upgrade`.

## Git and Windows Caveats

- The repository root may contain a Windows-reserved `nul` file. Do not use `git add -A` or `git add .`; stage explicit file paths only.
- `.mcp.json` and `.copilot/mcp-config.json` are often locally modified by workspace configuration. Do not include or revert those files unless the task explicitly requires it.
- Use Windows-style paths in shell commands.
- Never revert unrelated user changes. If unrelated dirty files are present, leave them alone and stage only files changed for the current task.

## Runtime Architecture

- Optimus uses a user-level, multi-workspace HTTP runtime daemon. Workspace is request scope, not daemon process identity.
- Body-driven run creation uses `workspace_path`; status and stream lookups use `X-Optimus-Workspace`.
- Key runtime layers:
  - `src/mcp/mcp-server.ts`: MCP tool schemas and handlers.
  - `src/mcp/worker-spawner.ts`: task execution orchestration and worker lifecycle.
  - `src/runtime/genericExecutor.ts`: engine-to-adapter routing and HTTP runtime proxy behavior.
  - `src/runtime/genericRuntime.ts` and `src/runtime/http-server.ts`: in-memory run lifecycle and HTTP endpoints.
  - `src/adapters/AcpAdapter.ts`: ACP process/session handling for Copilot and Claude.
  - `src/mcp/meta-cron-engine.ts`: Meta-Cron scheduling, status persistence, and reconciliation.
- Runtime proxy behavior should prefer asynchronous start plus status polling over long synchronous HTTP requests.

## Fleet and Long-Running MCP Safety

- The shipped `optimus-fleet` skill is temporarily disabled because strict `optimus_orchestrate` passthrough can hit MCP request timeouts when `wait_for_completion=true` blocks the tool handler.
- Do not route broad tasks through `optimus_orchestrate` until the MCP-safe async orchestration path is fixed and validated.
- For long-running work, use non-blocking task creation and poll status separately. Avoid holding an MCP tool call open while waiting for terminal state.
- If a request reports MCP `-32001` timeout, investigate whether the handler blocked longer than the MCP client request timeout before retrying the same command.

## Runtime Validation Matrix

Use the narrowest relevant subset first, then widen coverage before completion:

- MCP schema/async behavior: `npx vitest run src/test/delegate-task-compat.test.ts src/test/optimus-orchestrator.test.ts`
- Runtime proxy and generic runtime: `npx vitest run src/test/genericRuntime.test.ts src/test/httpRuntimeHelpers.test.ts`
- ACP behavior: `npx vitest run src/test/AcpAdapter.unit.test.ts src/test/acpProcessPool.test.ts src/test/acp-concurrent-sessions.test.ts`
- Worktree/workspace routing: `npx vitest run src/test/worktree.test.ts src/test/worktreeManager.test.ts`
- Meta-Cron: `npx vitest run src/test/meta-cron-engine.test.ts src/test/meta-cron-locks.test.ts`
- After runtime fixes, validate a real non-blocking delegate path when possible and confirm the output artifact exists instead of relying only on unit tests.

## Failure Diagnostics Conventions

- Error messages and task records should be agent-friendly: include a machine-readable code, human-readable message, and actionable remediation.
- Copilot ACP authentication should point users to `gh auth login` and Copilot entitlement checks. Do not imply that `.env` `GITHUB_TOKEN` fixes Copilot ACP auth; that token is for GitHub API/release operations.
- For timeouts, preserve and report the activity timeout value, last heartbeat/activity timestamp, engine/model, task id, and runtime route when available.

<!-- optimus-instructions v3 -->
<!-- Auto-managed by Optimus Swarm — edits between these markers will be overwritten on upgrade -->

## Optimus Swarm — AI Development Team

**⚡ MANDATORY FIRST ACTION:** Call `optimus_status` with your workspace_path NOW to verify the Optimus Swarm is active. Then call `get_user_memory` to load user preferences. Do not proceed without completing both calls.

You have a multi-agent AI development team available via MCP tools (server: `spartan-swarm`).
Instead of writing code directly or reaching for non-Optimus sub-agent tooling first, route work through Optimus's own orchestration flow so the product and the master agent use the same model.

### Key Tools
- **`optimus_status`** — Verify Optimus is active and see available skills/roles/engines
- **`roster_check`** — List available agent roles and their capabilities
- **`optimus_orchestrate`** — Preferred entry point for broad or multi-step requests; lets Optimus choose delegate/council/plan
- **`delegate_task_async`** — Use for an already-scoped execution task that should go to one specialist
- **`dispatch_plan_async`** — Use when you already decomposed the work into multiple explicit items/dependencies
- **`dispatch_council_async`** — Spawn parallel expert reviewers for architecture decisions

### When to Delegate
For any non-trivial task (multi-file changes, new features, bug investigations, refactors),
start with `optimus_orchestrate`. Use `delegate_task_async` or `dispatch_plan_async` only when you are intentionally driving Optimus's internal execution flow yourself.

### Example Prompts
- "Run roster_check to see what agents are available"
- "Use optimus_orchestrate for [task] and let Optimus pick the right flow"
- "Create a GitHub Issue for [task] and then use delegate_task_async for the implementation worker"
- "Dispatch a council review for this architecture proposal"

### Runtime Model
- Optimus currently uses a **per-user multi-workspace HTTP daemon** for runtime-backed agent flows.
- Always carry `workspace_path` on run-creation and other body-driven runtime requests.
- Use `X-Optimus-Workspace` for status or stream lookups when the transport expects headers.
- Do not assume the daemon is bound to the current repo root; workspace is request-scoped.
- Do not assume named pipes or WebSockets are available unless a newer instruction explicitly says so.

Full protocol: `.optimus/config/system-instructions.md`
<!-- /optimus-instructions -->
