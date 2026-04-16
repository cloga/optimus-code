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

Full protocol: `.optimus/config/system-instructions.md`
<!-- /optimus-instructions -->
