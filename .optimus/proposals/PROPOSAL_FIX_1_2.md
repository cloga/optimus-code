# Architecture Remediation Proposal (Issues 1 & 2)

## Context
Following the recent architecture review (Epic #18), we have identified two critical issues in the MCP server (`src/mcp/mcp-server.ts` and `src/mcp/worker-spawner.ts`):
1. **Concurrency File Writes (Race Conditions):** `fs.writeFileSync` and `fs.appendFileSync` are invoked concurrently without locks, leading to silent dataloss across the Spartan Swarm workers when they write task artifacts or reviews.
2. **CWE-22 Path Traversal (Security):** `dispatch_council` calculates workspace roots loosely (`indexOf('.optimus')`) and accepts unbounded `role` names, opening severe directory traversal and escaping vulnerabilities.

## Proposed Remediation Strategy

### 1. Fix Path Validations (CWE-22)
- Enforce strict regex matching for role arrays (`/^[a-zA-Z0-9_-]+$/`).
- Refactor dynamic workspace extraction from `proposal_path`. Instead of slicing at `.optimus`, require an explicit `workspace_path` to be sent in the MCP payload, or safely `path.resolve` and verify it stays inside a known bound.

### 2. File Locking (Concurrency)
- *Option A:* Immediate integration of `proper-lockfile` wrapping all `fs.writeFileSync` in `mcp-server.ts`.
- *Option B:* Migrate the shared data format immediately to an embedded SQLite datastore (`better-sqlite3`).

### 3. Review Request
We are delegating this to the council (`security`, `architect`).
- **Security:** Please confirm the path validation strategy covers all edge cases.
- **Architect:** Decide on Option A vs Option B for the next iteration (Sprint 1) given our need for speed but reliability.