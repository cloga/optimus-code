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
