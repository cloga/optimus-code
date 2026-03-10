● Read optimus-code\.optimus\PROPOSAL_directory_structure.md
  └ 25 lines read

● List directory optimus-code\.optimus
  └ 19 files found

● Read optimus-code\.optimus\memory.md
  └ 38 lines read

● Read optimus-code\.optimus\rules.md
  └ 147 lines read

● Read optimus-code\.optimus\protocol.md
  └ 15 lines read

● List directory optimus-code\.optimus\tasks
  └ 6 files found

● List directory optimus-code\.optimus\registry
  └ 2 files found

● Preview delegate.js
  $ Get-Content "C:\Users\lochen\optimus-code\.optimus\delegate.js" | Select-Object -First 30
  └ 19 lines...

Now I have full context. Here is my expert architectural critique:

---

## 🏛️ System-Architect Critique: `.optimus/` Restructuring Proposal

**Role:** T3 / System Architect (Zero-Shot Outsource)
**Date:** 2026-03-10

---

### 1. PRE-EXISTING CRITICAL DEFECTS (Must Fix Before or During Restructure)

These are bugs in the *current* state, independent of the proposal's scope, that the restructure must not perpetuate:

#### 🔴 `protocol.md` — Encoding Corruption
The file is stored in UTF-16LE with BOM, causing every character to be double-spaced when read by Node.js or most agent runtimes expecting UTF-8. **Any agent ingesting `protocol.md` as a system prompt is receiving garbled, unparseable instructions.** This is a silent operational failure — no error is thrown, agents simply behave as if the protocol doesn't exist.

#### 🔴 `rules.md` — Duplicated Content Block
Lines 89–118 and lines 119–148 are **verbatim duplicates** of the "Autonomy & Master Agent Philosophy," "Architecture Direction," "Spartan Swarm Toolkit," and "Orchestrator Skills" sections. The file is the declared *Single Source of Truth* — having internal duplication violates that contract and risks divergent edits over time.

#### 🟠 `delegate.js` — Security Surface
This script passes `--dangerously-skip-permissions` to Claude Code unconditionally. A loose script at the blackboard root — potentially invokable by any agent interpreting a task — represents an unguarded privilege escalation path. It has no caller validation, no rate limiting, and no audit logging.

#### 🟠 `tasks/` — Inconsistent Naming Schema
Files use two incompatible ID schemes: epoch timestamps (`task_1773103648932.md`) and UUIDs (`task_4f56ed52-...`). This makes programmatic sorting, de-duplication, and lifecycle queries fragile.

---

### 2. ARCHITECTURAL ANALYSIS OF THE PROPOSAL

#### 2a. Taxonomy / Namespace Collision (DX Friction)
**Problem:** Proposal files, configuration files, and executable scripts coexist at the root with no namespace. There is no way to distinguish "runtime-critical" files from "ephemeral planning artifacts" by path alone.

**Proposed fix:** Move `PROPOSAL_*.md` → `proposals/`. ✅ **Correct.**

**Gap in proposal:** It does not distinguish between:
- **Runtime config** (`rules.md`, `protocol.md`) — read on every agent invocation, must be UTF-8, versioned, immutable mid-run.
- **Stateful memory** (`memory.md`, `TODO.md`) — mutated at runtime by agents, require concurrency controls.

These should live in separate directories, not co-mingled at root or both dumped into a vague `config/`.

#### 2b. Script Placement (DX + Security)
**Proposal:** Move `delegate.js`, `script-check.js`, `test-council.js` → `.optimus/scripts/`. ✅ **Directionally correct.**

**Gap:** The proposal does not address *access control* or *invocation policy*. If scripts remain directly invokable by agents with no manifest declaring their purpose, risk surface is unchanged. A `scripts/README.md` or `scripts/manifest.json` listing each script's purpose, caller, and required permissions should accompany the move.

#### 2c. Core Rule Files Placement
**Proposal:** "Where should `rules.md`, `memory.md`, `protocol.md` reside?"

**Recommendation (not given in proposal):**

```
.optimus/
  config/           ← STATIC runtime config; read-only during agent runs
    rules.md
    protocol.md
    personas/       ← (move from root)
  state/            ← MUTABLE state; written by agents during runs
    memory.md
    TODO.md
    BLOCKERS.md     ← escalation artifact
  tasks/            ← task execution artifacts
  proposals/        ← planning/architecture discussions
  reports/
  reviews/
  scripts/
  registry/
  runtime-prompts/
```

The critical architectural principle here is **read-only vs mutable state separation**. Agents that write to `config/` mid-run are a data corruption risk.

#### 2d. Asynchronous Race Condition Risk (CRITICAL GAP not addressed in proposal)
`TODO.md` is the shared task queue. The `protocol.md` instructs agents to: *"rewrite TODO.md to change exactly that task's status."* With multiple concurrent agents (the swarm model this system is built for), two agents can:

1. Both read `TODO.md` and see the same unclaimed task.
2. Both mark it in-progress.
3. Both execute it.
4. One overwrites the other's completion mark.

**The proposal does not address this at all.** A file-based blackboard without a locking primitive (file lock, advisory lock file, or atomic rename) is fundamentally unsafe for a multi-agent swarm. Recommendations:
- Introduce `.optimus/state/TODO.lock` advisory locking, **or**
- Migrate task state to an append-only log + separate status file, **or**
- Formalize that only the Master Orchestrator may write `TODO.md` (workers write to a `DONE/` inbox and the orchestrator reconciles).

#### 2e. No Archival / Retention Policy
`tasks/` will grow unbounded. The proposal does not address archival, rotation, or cleanup. Recommendation: a `tasks/archive/` subdirectory with a documented policy (e.g., completed tasks older than 7 days are moved there by the orchestrator).

---

### 3. EVALUATION SUMMARY

| Concern | Severity | Addressed by Proposal? |
|---|---|---|
| `protocol.md` encoding corruption | 🔴 Critical | ❌ No |
| `rules.md` duplication | 🟠 High | ❌ No |
| `delegate.js` privilege escalation | 🟠 High | ⚠️ Partially (move only) |
| TODO.md race condition (swarm) | 🔴 Critical | ❌ No |
| Flat namespace / taxonomy | 🟡 Medium | ✅ Yes |
| Script invocation security | 🟠 High | ❌ No |
| Config vs state separation | 🟠 High | ❌ No |
| tasks/ naming inconsistency | 🟡 Medium | ❌ No |
| No archival strategy | 🟡 Medium | ❌ No |

---

### 4. RECOMMENDATION: **HYBRID** ⚠️

**Do not reject** — the motivation (clean up flat root namespace) is architecturally valid and the proposal correctly identifies the symptom.

**Do not accept as-is** — the proposal solves only the cosmetic/DX surface problem without addressing the two critical risks: runtime encoding corruption and multi-agent write races.

**Hybrid path:**

Execute the restructure (proposals/, scripts/, formalize subdirs) **and simultaneously**:

1. Re-encode `protocol.md` as UTF-8.
2. De-duplicate `rules.md`.
3. Split root files into `config/` (static) and `state/` (mutable).
4. Add an advisory lock protocol to `TODO.md` mutation (even a simple `.TODO.lock` sentinel file with PID).
5. Add `scripts/manifest.json` documenting each script's caller, purpose, and permission level.

**Shell commands to implement the safe hybrid:**

```powershell
# PowerShell — run from repo root
$base = ".optimus"

# Create new directories
New-Item -ItemType Directory -Force "$base\proposals"
New-Item -ItemType Directory -Force "$base\scripts"
New-Item -ItemType Directory -Force "$base\config"
New-Item -ItemType Directory -Force "$base\state"
New-Item -ItemType Directory -Force "$base\tasks\archive"

# Move proposals
Get-ChildItem "$base\PROPOSAL_*.md" | Move-Item -Destination "$base\proposals\"

# Move scripts
Move-Item "$base\delegate.js"      "$base\scripts\"
Move-Item "$base\script-check.js"  "$base\scripts\"
Move-Item "$base\test-council.js"  "$base\scripts\"

# Move static config (read-only at runtime)
Move-Item "$base\rules.md"    "$base\config\"
Move-Item "$base\protocol.md" "$base\config\"

# Move mutable state
Move-Item "$base\memory.md" "$base\state\"
Move-Item "$base\TODO.md"   "$base\state\"

# Re-encode protocol.md to UTF-8 (fix corruption)
$content = Get-Content "$base\config\protocol.md" -Encoding Unicode
Set-Content  "$base\config\protocol.md" -Value $content -Encoding UTF8
```

> **Note:** After the move, update all path references in `src/managers/SharedTaskStateManager.ts` and `src/managers/MemoryManager.ts` that currently hardcode `.optimus/memory.md`, `.optimus/rules.md`, and `.optimus/TODO.md` — these are the runtime read/write paths and will break silently if not updated.


> [LOG] 
Total usage est:        1 Premium request
API time spent:         1m 15s
Total session time:     1m 23s
Total code changes:     +0 -0
Breakdown by AI model:
 claude-sonnet-4.6       113.1k in, 3.8k out, 94.1k cached (Est. 1 Premium request)