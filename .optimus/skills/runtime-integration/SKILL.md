---
name: runtime-integration
description: Integrate Optimus Agent Runtime into external applications via HTTP REST, TypeScript SDK, or CLI contract. Use when a user wants to embed AI agent capabilities into their own app, service, or CI/CD pipeline — without dealing with MCP transport.
---

# Agent Runtime Integration

Optimus Agent Runtime provides **3 application-facing transports** (HTTP, SDK, CLI)
plus MCP for AI editors. All share the same service layer, ACP warm pool, and
response format (`AgentRuntimeEnvelope`).

Choose the transport that matches your stack:

| Transport | Best For | Protocol | Cold Start |
|-----------|----------|----------|------------|
| HTTP REST | Web apps, microservices, any language | `POST /api/v1/agent/*` | None (warm pool) |
| TypeScript SDK | Node.js / TypeScript apps | `OptimusRuntime` class | None (wraps HTTP) |
| CLI Contract | Shell scripts, CI/CD, subprocess calls | `optimus-runtime <cmd>` | None (warm pool) |
| MCP stdio | AI editors (VS Code Copilot, Cursor) | JSON-RPC over stdio | None (warm pool) |

## Request Schema

All transports accept the same input:

```json
{
  "role": "string (required)",
  "input": "any (required)",
  "workspace_path": "string (required)",
  "skill": "string (optional)",
  "instructions": "string (optional)",
  "output_schema": "JSON Schema (optional)",
  "role_engine": "string (optional, e.g. 'claude-code', 'github-copilot')",
  "role_model": "string (optional)",
  "role_description": "string (optional)",
  "agent_id": "string (optional)",
  "context_files": ["string array (optional)"],
  "runtime_policy": {
    "mode": "sync | async",
    "timeout_ms": "number",
    "retries": "number",
    "fallback_engines": ["string array"]
  }
}
```

## Response Schema (`AgentRuntimeEnvelope`)

All transports return the same envelope:

```json
{
  "run_id": "run_1705123456_abc123",
  "trace_id": "uuid",
  "status": "queued | running | completed | failed | blocked_manual_intervention | cancelled",
  "result": "any (when completed)",
  "error_code": "string (when failed)",
  "error_message": "string (when failed)",
  "requires_manual_intervention": false,
  "action_required": "string (when blocked)",
  "runtime_metadata": {
    "role": "dev",
    "engine": "claude-code",
    "duration_ms": 15234,
    "output_path": ".optimus/results/agent-runtime/run_xxx.json",
    "retries_attempted": 0,
    "created_at": "ISO timestamp",
    "updated_at": "ISO timestamp"
  }
}
```

---

## Transport 1: HTTP REST Server

### Start

```bash
node .optimus/dist/http-runtime.js --port 3100 --workspace /path/to/project
# OR
OPTIMUS_WORKSPACE_ROOT=/path node .optimus/dist/http-runtime.js
```

### Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/v1/agent/run` | Sync run — blocks until complete |
| `POST` | `/api/v1/agent/start` | Async start — returns run_id immediately |
| `GET` | `/api/v1/agent/runs/:id` | Get status/result of a run |
| `POST` | `/api/v1/agent/runs/:id/resume` | Resume a blocked run |
| `POST` | `/api/v1/agent/runs/:id/cancel` | Cancel an active run |
| `GET` | `/api/v1/health` | Health check |

### Examples

**Sync run (Python):**
```python
import requests

result = requests.post('http://localhost:3100/api/v1/agent/run', json={
    'role': 'dev',
    'input': {'task': 'Add error handling to auth module'},
    'workspace_path': '/my/project'
}).json()

if result['status'] == 'completed':
    print(result['result'])
```

**Async run (curl):**
```bash
# Start
RUN_ID=$(curl -s -X POST http://localhost:3100/api/v1/agent/start \
  -H "Content-Type: application/json" \
  -d '{"role":"dev","input":{"task":"Refactor DB layer"},"workspace_path":"."}' \
  | jq -r .run_id)

# Poll
curl -s http://localhost:3100/api/v1/agent/runs/$RUN_ID | jq .status
```

---

## Transport 2: TypeScript SDK

### Install & Import

```typescript
import { OptimusRuntime } from '@cloga/optimus-swarm-mcp/sdk';
// OR from GitHub source:
import { OptimusRuntime } from './path-to/.optimus/dist/runtime-client';
```

### Initialize

```typescript
const runtime = new OptimusRuntime({
  baseUrl: 'http://localhost:3100',
  workspacePath: '/path/to/project',
  timeoutMs: 300_000   // 5 min
});
```

### API Methods

```typescript
// Sync run
const result = await runtime.runAgent({
  role: 'code-architect',
  input: { task: 'Design REST API' }
});

// Async start + poll
const envelope = await runtime.startRun({ role: 'dev', input: { task: '...' } });
const final = await runtime.waitForCompletion(envelope.run_id, {
  pollIntervalMs: 2000,
  timeoutMs: 120_000
});

// Resume blocked run
await runtime.resumeRun(runId, { human_answer: 'Yes, proceed' });

// Cancel
await runtime.cancelRun(runId, { reason: 'User cancelled' });

// Health
const health = await runtime.health();
```

---

## Transport 3: CLI JSON Contract

### Commands

```bash
optimus-runtime run     < request.json    # Sync — blocks until complete
optimus-runtime start   < request.json    # Async — returns run_id
optimus-runtime status  --run-id <id>     # Get status
optimus-runtime resume  < resume.json     # Resume blocked run
optimus-runtime cancel  --run-id <id>     # Cancel
```

- **stdout**: Always JSON (`AgentRuntimeEnvelope` or error)
- **stderr**: Logs/traces (never mixed into response)
- **Exit code**: 0 = success, 1 = error

### Example (Shell)

```bash
#!/bin/bash
RESULT=$(echo '{"role":"dev","input":{"task":"Fix auth"},"workspace_path":"."}' \
  | optimus-runtime run)

STATUS=$(echo "$RESULT" | jq -r .status)
[ "$STATUS" = "completed" ] && echo "Done!" || echo "Failed: $(echo $RESULT | jq -r .error_message)"
```

---

## Available Roles

Use `roster_check` (MCP) or check `.optimus/config/role-registry.json` for the
current list. Common roles:

| Role | Purpose |
|------|---------|
| `dev` / `senior-full-stack-builder` | Code implementation |
| `code-architect` | System design |
| `code-explorer` | Codebase analysis |
| `code-reviewer` | Code review |
| `product-manager` | Workflow orchestration |

---

## Architecture Notes

- All transports share one `AcpProcessPool` — warm agent processes are reused
  across HTTP, CLI, SDK, and MCP calls
- The service layer (`agentRuntimeService.ts`) runs tasks **in-process** (not
  subprocess), enabling warm pool sharing
- Results persist to `.optimus/results/agent-runtime/` and
  `.optimus/state/agent-runtime/` on disk
- CORS is enabled on the HTTP server (`Access-Control-Allow-Origin: *`)
- Max request body: 10 MB

## Anti-Patterns

- **Do NOT** use MCP transport for application integration — use HTTP/SDK/CLI
- **Do NOT** poll status faster than every 2 seconds (async runs)
- **Do NOT** omit `workspace_path` — it's required to locate `.optimus/` config
- **Do NOT** hardcode engine names — let the role registry resolve the best engine

---

## Authentication

Engine authentication is separate from Optimus's own GitHub API token (`.env` `GITHUB_TOKEN`).

| Engine | Auth Method | Setup |
|--------|------------|-------|
| `github-copilot` | `gh` CLI auth | Run `gh auth login` — Copilot ACP uses the gh CLI auth context automatically |
| `claude-code` | Anthropic login | Run `claude login` or set `ANTHROPIC_API_KEY` env var |

> **Note:** `.env` `GITHUB_TOKEN` is used by Optimus for GitHub API operations (issues, PRs), NOT for engine authentication. Copilot ACP reads auth from `~/.config/gh/hosts.yml` (managed by `gh auth`).

```bash
# Verify Copilot auth is working
gh auth status

# Start the runtime (no GH_TOKEN needed for Copilot)
node .optimus/dist/http-runtime.js --port 3100
```

---

## Warm Pool Behavior

The ACP process pool keeps engine processes alive between tasks:

- **First request** to an engine → cold start (~2–5s spawn + ACP initialize)
- **Subsequent requests** → reuse warm process (~0s spawn overhead)
- **Idle timeout** → adapter evicted after 5 minutes of inactivity (configurable via `timeout.activity_ms`)
- **Concurrent requests** → if the warm adapter is busy, an ephemeral adapter is spawned
- **Cross-model reuse** → same `copilot --acp` process can switch models between tasks

Pool status is logged to stderr:
```
[AcpPool] 🆕 Created persistent adapter for github-copilot        ← cold start
[AcpPool] ♻️  Reusing warm adapter for github-copilot (idle 25s)   ← warm reuse
[AcpPool] 💀 Adapter for github-copilot is dead, replacing        ← crash recovery
```

---

## Error Code Reference

All error responses follow the envelope format with `error_code` and `error_message`.
Use `error_code` for programmatic handling; `error_message` contains human-readable details.

### Request Validation Errors

| Error Code | HTTP Status | Cause | Fix |
|-----------|-------------|-------|-----|
| `missing_params` | 400 | Required field(s) missing (`role`, `workspace_path`, `input`) | Add the listed fields to your request |
| `invalid_json` | 400 | Request body is not valid JSON | Check JSON syntax; the response includes the parse error |
| `empty_body` | 400 | POST request with no body | Send a JSON body with required fields |
| `body_too_large` | 413 | Request exceeds 10 MB limit | Reduce input size or use `context_files` references |
| `invalid_timeout` | 400 | `timeout_ms` or `heartbeat_timeout_ms` out of range | Use a value between 1 and 1,200,000 ms |

### Engine / Model Errors

| Error Code | HTTP Status | Cause | Fix |
|-----------|-------------|-------|-----|
| `invalid_engine` | 400 | `role_engine` not found in `available-agents.json` | Check `.optimus/config/available-agents.json` for valid engine names |
| `invalid_model` | 400 | `role_model` not available for the specified engine | Remove `role_model` to use default, or check `available_models` in config |
| `auth_failed` | 401 | Engine CLI returned authentication error | Set auth token (see Authentication section) or run engine login command |
| `engine_not_available` | 503 | Engine CLI not installed or not on PATH | Install the engine CLI (`npm i -g @github/copilot`, `pip install claude-code`) |

### Execution Errors

| Error Code | HTTP Status | Cause | Fix |
|-----------|-------------|-------|-----|
| `runtime_execution_failed` | 500 | Task execution failed after all retries | Check `error_message` for details; may be auth, timeout, or engine crash |
| `task_timeout` | 504 | No activity from engine for the configured heartbeat period | Increase `runtime_policy.timeout_ms` or check if the engine is responsive |
| `acp_process_crashed` | 500 | ACP engine process exited unexpectedly | Retry — warm pool will auto-recover with a fresh process |
| `rate_limit` | 429 | Engine API rate limited | Wait and retry; consider using `runtime_policy.retries` |

### State Errors

| Error Code | HTTP Status | Cause | Fix |
|-----------|-------------|-------|-----|
| `run_not_found` | 404 | Run ID doesn't match any known run | Verify the `run_id`; runs are stored in `.optimus/state/agent-runtime/` |
| `task_not_found` | 404 | Task referenced by run no longer exists | The task manifest may have been cleaned up; start a new run |
| `invalid_state` | 400 | Operation not valid for current run state (e.g., resume on a non-blocked run) | Check run status before calling resume |
| `workspace_not_initialized` | 400 | `.optimus/` directory not found at workspace_path | Run `npx github:cloga/optimus-code#v2.16.4 init` in the workspace |

### Infrastructure Errors

| Error Code | HTTP Status | Cause | Fix |
|-----------|-------------|-------|-----|
| `not_found` | 404 | HTTP endpoint doesn't exist | Check the endpoint path against the API reference above |
| `internal_error` | 500 | Unclassified server error | Check `error_message` for details; report if persistent |

---

## Troubleshooting

### "Authentication required" from Copilot ACP
```json
{"error_code": "auth_failed", "error_message": "ACP error: Authentication required"}
```
**Fix:** Copilot ACP uses `gh` CLI auth, not env vars. Run:
```bash
gh auth login
gh auth status  # verify it's working
# Then restart the runtime
node .optimus/dist/http-runtime.js --port 3100
```

### "Invalid model 'X' for engine 'Y'"
```json
{"error_code": "invalid_model", "error_message": "Invalid model 'gpt-99' for engine 'github-copilot'. Valid models: gpt-5.4, claude-opus-4.6-1m, gemini-3-pro-preview"}
```
**Fix:** Remove `role_model` from request to use the default, or use one of the listed valid models.

### Task completes but `result` is empty
The result is written to the file at `runtime_metadata.output_path`. Read that file for full output:
```bash
cat .optimus/results/agent-runtime/run_xxx.json
```

### "Activity timeout: no session/update for Ns"
The engine stopped sending progress. Possible causes:
- Engine process hung or crashed
- Network issue (for cloud-based models)
- Task too complex for the timeout window

**Fix:** Increase timeout via `runtime_policy.timeout_ms` or check engine health.

### Warm pool not reusing processes
Check logs for `🆕 Created` vs `♻️ Reusing`. If always creating:
- Previous task may have crashed the process (check for `💀 dead`)
- Concurrent requests may exhaust the pool (ephemeral adapters used)
- Idle timeout (5 min default) may have evicted the adapter
