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
