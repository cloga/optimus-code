• report_intent
↳ intent
• task
↳ description=Sanity check MCP server
✓ report_intent
↳ result=Intent logged
• view
↳ path=C:\Users\lochen\optimus-code
• glob
↳ pattern=**/*mcp*
• glob
↳ pattern=**/*server*
• view
↳ path=C:\Users\lochen\optimus-code\package.json
✓ view
↳ result=lines=52, preview=.claude
✓ view
↳ result=lines=257, preview=1. {
✓ glob
↳ result=items=6, first=.\test-ipc\direct-mcp-test.js
✓ glob
↳ result=items=1, first=.\src\mcp\mcp-server.ts
• view
↳ path=C:\Users\lochen\optimus-code\src
• view
↳ path=C:\Users\lochen\optimus-code\call_mcp.js
• view
↳ path=C:\Users\lochen\optimus-code\src\mcp\mcp-server.ts
✓ view
↳ result=lines=10, preview=adapters
✓ view
↳ result=lines=227, preview=1. import { Server } from "@modelcontextprotocol/sdk/server/index.js";
✓ view
↳ result=lines=39, preview=1. const { spawn } = require('child_process');
• view
↳ path=C:\Users\lochen\optimus-code\src\mcp
• view
↳ path=C:\Users\lochen\optimus-code\optimus-plugin\.mcp.json
• glob
↳ pattern=src/mcp/**
✓ view
↳ result=lines=2, preview=mcp-server.ts
✓ view
↳ result=lines=8, preview=1. {
✓ glob
↳ result=items=2, first=.\src\mcp\worker-spawner.ts
• view
↳ path=C:\Users\lochen\optimus-code\src\mcp\worker-spawner.ts
• glob
↳ pattern=optimus-plugin/scripts/**
✓ view
↳ result=lines=190, preview=1. import { spawn } from "child_process";
✓ glob
↳ result=items=1, first=No files matched the pattern.
• view
↳ path=C:\Users\lochen\optimus-code\optimus-plugin
• glob
↳ pattern=optimus-plugin/**/*.{js,ts}
✓ view
↳ result=lines=8, preview=.claude-plugin
✓ glob
↳ result=items=1, first=No files matched the pattern.
• powershell
↳ command=Get-ChildItem -Path "C:\Users\lochen\optimus-code\optimus-plugin\scripts" -File, description=List files in optimus-plugin/scripts
✓ powershell
↳ result=stdout=4 lines, preview=Directory: C:\Users\lochen\optimus-code\optimus-plugin\scriptsMode LastWriteTime
• grep
↳ path=C:\Users\lochen\optimus-code, pattern=mcp-server\.js
✗ grep
↳ result=matches=0
• powershell
↳ command=Get-ChildItem -Path "C:\Users\lochen\optimus-code\optimus-plugin" -Recurse -Filter "mcp-serve..., description=Find mcp-server.js file
✓ powershell
↳ result=stdout=8 lines, preview=Directory:
• view
↳ path=C:\Users\lochen\optimus-code\optimus-plugin\package.json
• powershell
↳ command=cd C:\Users\lochen\optimus-code && find . -name "tsconfig.json" -o -name "esbuild.js" | Selec..., description=Check build configuration
✓ view
↳ result=lines=10, preview=1. {
✓ powershell
↳ result=stdout=2 lines, preview=FIND: Parameter format not correct
• view
↳ path=C:\Users\lochen\optimus-code\esbuild.js
• view
↳ path=C:\Users\lochen\optimus-code\src\adapters\GitHubCopilotAdapter.ts
✓ view
↳ result=lines=84, preview=1. const esbuild = require('esbuild');
✓ view
↳ result=lines=50, preview=1. import { PersistentAgentAdapter } from './PersistentAgentAdapter';
• glob
↳ pattern=**/*.test.ts
• glob
↳ pattern=**/*.spec.ts
• grep
↳ path=C:\Users\lochen\optimus-code\src\mcp, pattern=catch|error|Error|throw
✓ glob
↳ result=items=1, first=.\src\test\Calculator.test.ts
✓ glob
↳ result=items=1, first=No files matched the pattern.
✓ grep
↳ result=matches=2, preview=C:\Users\lochen\optimus-code\src\mcp\worker-spawner.ts:11
• grep
↳ path=C:\Users\lochen\optimus-code\src\mcp\mcp-server.ts, pattern=catch|try|throw McpError
• grep
↳ path=C:\Users\lochen\optimus-code\src\mcp\worker-spawner.ts, pattern=catch|try
✓ grep
↳ result=matches=12, preview=C:\Users\lochen\optimus-code\src\mcp\mcp-server.ts: // --- Dynamic Registry Load
✓ grep
↳ result=matches=3, preview=C:\Users\lochen\optimus-code\src\mcp\worker-spawner.ts: try {
• view
↳ path=C:\Users\lochen\optimus-code\src\mcp\mcp-server.ts
• view
↳ path=C:\Users\lochen\optimus-code\optimus-plugin\scripts\mock-worker.js
✓ view
↳ result=lines=16, preview=150. const registryPath = path.join(workspace_path; ".optimus"; "registry"; "ava
✓ view
↳ result=lines=73, preview=1. import fs from "fs";
• view
↳ path=C:\Users\lochen\optimus-code\src\adapters
• grep
↳ path=C:\Users\lochen\optimus-code\src\adapters, pattern=import.*worker-spawner|from.*mcp|from.*\.\.\/mcp
✓ view
↳ result=lines=5, preview=AgentAdapter.ts
✓ grep
↳ result=matches=1, preview=No matches found.
• grep
↳ path=C:\Users\lochen\optimus-code\src\mcp, pattern=import.*adapters|from.*\.\.\/adapters
• view
↳ path=C:\Users\lochen\optimus-code\src\adapters\PersistentAgentAdapter.ts
✓ view
↳ result=lines=80, preview=1. import { AgentAdapter } from './AgentAdapter';
✓ grep
↳ result=matches=1, preview=C:\Users\lochen\optimus-code\src\mcp\worker-spawner.ts
• view
↳ path=C:\Users\lochen\optimus-code\src\extension.ts
✓ view
↳ result=lines=50, preview=1. import * as vscode from 'vscode';
✓ task
↳ result=94 lines, preview=Perfect! Now I have enough information. Let me create a comprehensive...

Now let me view the src directory structure and examine the key MCP files:Now let me check the worker-spawner and look at the mcp directory structure:Let me check the optimus-plugin directory structure:Let me check if there's a compiled version or if mcp-server.js is built from mcp-server.ts:Now let me check for tests and look at error handling in key files:Perfect! Now let me check for circular dependencies and review the adapters structure:Perfect! Now I have enough information. Let me create a comprehensive summary:

## MCP Server Architecture Summary

### (1) **What the MCP Server Does**

The MCP server ("optimus-facade") is a **Model Context Protocol server** that orchestrates a multi-agent system called the **Spartan Swarm**. It provides three primary tools:

- **`dispatch_council`**: Spawns multiple expert workers concurrently to review architectural proposals (map-reduce pattern). Each expert role executes independently in parallel and writes a review file.
- **`roster_check`**: Returns a unified directory of available AI roles (T1 Local, T2 Global, T3 Generic), supported execution engines, and their model variants.
- **`delegate_task`**: Delegates a single task to a designated expert role with automatic tier-resolution (T1→T2→T3 cascade).

**Architecture Philosophy**: Acts as a facade/marionette controller that spawns autonomous worker processes (CLI-based agents) rather than running them directly. Designed for stateless, concurrent execution with isolation.

---

### (2) **Key Files/Modules & Structure**

| File/Module | Purpose |
|---|---|
| **`src/mcp/mcp-server.ts`** | Core MCP server; registers tools, validates requests, orchestrates dispatch |
| **`src/mcp/worker-spawner.ts`** | Spawns child processes for worker execution; implements concurrent dispatch and single-task delegation |
| **`optimus-plugin/scripts/mcp-server.js`** | Compiled output (built from mcp-server.ts via esbuild) |
| **`optimus-plugin/scripts/mock-worker.js`** | Mock worker for testing; simulates expert role execution |
| **`src/adapters/GitHubCopilotAdapter.ts`** | Adapter for CLI-based AI agents (GitHub Copilot CLI) |
| **`call_mcp.js`** | Entry point that spawns the MCP server as a child process and sends a test request |
| **`esbuild.js`** | Build configuration; compiles mcp-server.ts + extension.ts to `out/` directory |
| **`package.json`** (root) | Lists dependencies: none for MCP core (SDK is in optimus-plugin) |
| **`optimus-plugin/package.json`** | Defines MCP module; depends on `@modelcontextprotocol/sdk ^1.0.1` |

**Flow**:
1. `call_mcp.js` spawns `mcp-server.js` as stdio-transport child process
2. Sends JSON-RPC request (e.g., `dispatch_council`)
3. MCP server parses request → calls `worker-spawner.ts` functions
4. Worker-spawner spawns mock-worker.js (or real CLI agents) as independent processes
5. Reviews/results written to `.optimus/reviews/` or output paths

---

### (3) **Architectural Issues & Concerns**

#### 🔴 **Critical Issues**

1. **Silent Error Swallowing** (Lines 164, mcp-server.ts):
   ```typescript
   } catch (e) {} // Empty catch block — JSON parse errors ignored silently
   ```
   — Makes debugging registry failures impossible.

2. **No Input Validation for Paths**:
   - `dispatch_council` & `delegate_task` accept arbitrary `proposal_path`/`output_path` from clients
   - No checks for path traversal attacks (e.g., `../../etc/passwd`)
   - Workspace resolution uses substring search on `.optimus` (fragile, could match unintended paths)

3. **Promise.all Doesn't Fail Fast** (worker-spawner.ts, line 88):
   ```typescript
   return Promise.all(promises); // If one worker crashes, others keep running
   ```
   — Individual worker failures are resolved as strings, not rejected, so the whole dispatch succeeds even if some workers fail silently.

4. **No Tests**:
   - Only `src/test/Calculator.test.ts` exists (not MCP-related)
   - Zero unit/integration tests for MCP server or worker-spawner
   - Mock worker is hardcoded (no real AI agent integration tested)

#### 🟡 **Moderate Issues**

5. **Weak Process Spawn Error Handling** (worker-spawner.ts, lines 47–68):
   - `child.on("close")` doesn't distinguish between normal exit and crash
   - Fallback writes stdout to file even on non-zero exit codes (obfuscates errors)
   - No timeout handling for hung processes

6. **Loose Type Safety**:
   - `request.params.arguments as any` (mcp-server.ts, line 93, 181, etc.)
   - No Zod/runtime schema validation — relies on TypeScript compile-time checks only

7. **Hardcoded Workspace Resolution**:
   - Lines 104–110 in mcp-server.ts: substring search for `.optimus` is brittle
   - Falls back to parent directory of proposal — could resolve to wrong root in monorepos

8. **Uncontrolled File I/O**:
   - `fs.mkdirSync(reviewsPath, { recursive: true })` — no size limits
   - `fs.writeFileSync()` — can silently overwrite files; no atomic writes
   - No cleanup of old reviews (accumulate indefinitely)

9. **Adapter Invocation Lacks Timeout**:
   - worker-spawner.ts line 177: `await adapter.invoke(...)` has no timeout
   - GitHubCopilotAdapter could hang indefinitely

10. **Circular Dependency Risk** (Mitigated but Fragile):
    - worker-spawner.ts imports GitHubCopilotAdapter (line 5)
    - GitHubCopilotAdapter imports PersistentAgentAdapter
    - PersistentAgentAdapter imports AgentAdapter
    - No circular imports detected currently, but tight coupling could introduce cycles

#### 🟢 **Minor Issues**

11. **Incomplete Error Messages**:
    - Line 214: `Unknown tool: ${request.params.name}` — no logging of available tools
    
12. **Process Stdio Configuration** (worker-spawner.ts, line 32):
    - `stdio: ["ignore", "pipe", "pipe"]` — parent can't send signals to worker; worker is orphaned if parent dies

13. **Session/Request IDs Not Logged Consistently**:
    - Lines 119, 204 log to stderr with `console.error()` — mixes debug info with actual errors
    - No structured logging framework

14. **No Built-in Rate Limiting or Concurrency Limits**:
    - `Promise.all()` spawns unlimited parallel workers
    - Large role arrays could DOS the system

---

### **Summary Table**

| Aspect | Status |
|--------|--------|
| **Architecture** | Sound (modular spawner + adapter pattern) |
| **Error Handling** | ❌ Poor (silent catches, no validation, fallback writes) |
| **Tests** | ❌ None for MCP |
| **Circular Deps** | ✅ None detected |
| **Security** | ⚠️ Path traversal risk, no input validation |
| **Concurrency** | ⚠️ Unlimited parallel spawning, no timeouts |
| **Logging** | ⚠️ Mixed stderr output, no structured logs |

**Recommendation**: Add schema validation (Zod), wrap error handling in try-catch blocks with logging, add unit tests, implement process timeouts, and sanitize path inputs.**Sanity check complete.** The MCP server (`optimus-facade`) follows a sound modular pattern — a JSON-RPC facade that dispatches concurrent worker processes via a spawner/adapter chain — but has notable reliability gaps including silent error swallowing in catch blocks, no input path validation (path traversal risk), and zero MCP-specific tests. The architecture is functional for development but not production-hardened.