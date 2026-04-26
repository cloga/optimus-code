---
name: optimus-fleet
description: TEMPORARILY DISABLED. Do not use this skill for automatic Optimus fleet dispatch. The Optimus orchestrator passthrough is currently disabled because wait_for_completion can exceed MCP request timeouts; when users ask for optimus-fleet, fleet mode, or automatic orchestration, explain that the skill is disabled and use manual step-by-step execution or direct sub-agents instead.
license: MIT
---

# Optimus Fleet Orchestrator — Temporarily Disabled

This skill is intentionally disabled until the underlying Optimus MCP orchestration timeout is fixed and validated.

## Why this is disabled

The previous implementation forced a strict passthrough call to `optimus_orchestrate` with `wait_for_completion=true` and a long completion timeout. In current MCP clients, long-running tool calls can exceed the MCP request timeout and fail with:

```text
McpError: MCP error -32001: Request timed out
```

That failure mode is worse than a normal task failure because it makes the orchestration entrypoint itself unreliable and can leave the user believing work is being managed when the controlling request has already timed out.

## Required behavior while disabled

When this skill triggers:

1. Do not call `optimus_orchestrate` as a passthrough.
2. Tell the user that `optimus-fleet` is temporarily disabled because the orchestrator can hit MCP request timeouts.
3. Continue with a safer manual workflow:
   - decompose the task into explicit todos,
   - dispatch direct sub-agents with the `task` tool when useful,
   - use local tools for implementation and verification,
   - keep the user informed that the result is not fleet-native end-to-end orchestration.
4. If the user explicitly asks to re-enable fleet, explain that the source fix should first cap or redesign `wait_for_completion` so MCP calls return before the client request timeout, then add regression tests for the timeout path.

## Re-enable criteria

Only restore strict fleet passthrough after all of the following are true:

1. `optimus_orchestrate`, `delegate_task_async`, and `dispatch_plan_async` no longer block an MCP request longer than the MCP client timeout.
2. `wait_for_completion=true` either uses an MCP-safe cap or is replaced by an async polling workflow.
3. Regression tests cover timeout capping, default non-blocking behavior, terminal status polling, and failure reporting.
4. A real end-to-end fleet run completes or returns a controlled non-timeout result.
