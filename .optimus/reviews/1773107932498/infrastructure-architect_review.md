● Read optimus-code\.optimus\PROPOSAL_directory_structure.md
  └ 25 lines read

● List directory optimus-code\.optimus
  └ 19 files found

● List directory optimus-code\.optimus\personas
  └ 2 files found

● List directory optimus-code\.optimus\registry
  └ 2 files found

● List directory optimus-code\.optimus\tasks
  └ 6 files found

● List directory optimus-code\.optimus\reports
  └ 1 file found

● List directory optimus-code\.optimus\runtime-prompts

● List directory optimus-code\.optimus\reviews
  └ 13 files found

● Read optimus-code\.optimus\protocol.md
  └ 15 lines read

● Read optimus-code\.optimus\delegate.js
  └ 18 lines read

● Read optimus-code\.optimus\rules.md
  └ 147 lines read

---

## Infrastructure Architect Critique: `.optimus/` Directory Structure PROPOSAL

**Role:** T3 Infrastructure Architect (Zero-Shot Outsource)
**Date:** 2026-03-10
**Scope:** `.optimus/` blackboard directory for the Spartan Swarm / Optimus-Code orchestration system

---

### 1. Assessment of Current State (Ground Truth)

Having read both the proposal and the live filesystem, the following material findings supplement what the proposal describes:

| Item | Observation |
|------|-------------|
| `protocol.md` | **File is encoded in UTF-16LE** (every character separated by a null byte). Agents that read this file via plain UTF-8 `fs.readFile` will receive garbled instructions — a silent operational failure. |
| `rules.md` | Contains **two verbatim duplicate blocks**: "Autonomy & Master Agent Philosophy" and "Architecture Direction" and "Spartan Swarm Toolkit" each appear **twice**. The authoritative source of truth is internally contradictory. |
| `reviews/` | Mixes **numeric timestamp directories** (e.g. `1773100990006`) with **named review files** (`security-expert_review.md`). No manifest or index. Discovery is O(n) full-scan. |
| `tasks/` | Mixed ID schemes: `task_<UUID>` and `task_<numeric-timestamp>` coexist. Ordering and dependency resolution are non-deterministic. |
| `runtime-prompts/` | Contains only numeric timestamp directories — **empty at time of inspection or content not indexed**. No schema for what belongs there vs. `tasks/`. |
| `delegate.js` | Uses `spawnSync` — **fully synchronous, blocking I/O**. The entire orchestrator halts for every delegation call. |

---

### 2. Architectural Bottlenecks

#### 2a. `delegate.js` Synchronous Blocking (`spawnSync`)
`spawnSync` is a process-level mutex. Every call to `delegate.js` freezes the Node.js event loop until the child CLI exits. This makes **parallel fan-out impossible** — the "Swarm" in Spartan Swarm cannot actually swarm. Any future feature involving concurrent agent execution (e.g., parallel review by `security-expert` + `ux-expert` + `performance-expert` — which already exists in `reviews/`) is architecturally strangled at the dispatcher layer.

**Fix required:** Replace `spawnSync` with `spawn` + Promise wrapper, or rewrite as an `async` function using `child_process.execFile`.

#### 2b. `TODO.md` as Sole Shared Mutable State
The protocol mandates all workers read and rewrite `TODO.md`. This is a **single-file, no-lock, shared state bus**. It is the architectural equivalent of a single-threaded message queue with no consumer acknowledgment. Two workers executing in parallel (even with slight timing offsets) will produce a **last-write-wins corruption**. The numbered `reviews/` subdirectories suggest concurrent workers have already been run.

**Fix required:** Atomically-named per-task state files (e.g., `tasks/<id>.state.json`) with CAS semantics, or a lightweight SQLite blackboard instead of flat Markdown.

#### 2c. No Task Recovery / Zombie Detection
When a worker crashes mid-execution, the task remains in `[]` (pending) state in `TODO.md` but the partial artifact may exist in `tasks/`. There is no heartbeat, no `in_progress` state, and no recovery path documented. The system cannot distinguish "not started" from "crashed after starting."

---

### 3. Developer Experience (DX) Friction

#### 3a. Zero Taxonomy Enforcement
The proposal correctly identifies six `PROPOSAL_*.md` files at root. However, it understates the problem: there is also no lifecycle state attached to proposals. `PROPOSAL_github_blackboard.md` and `PROPOSAL_SCM_MCP.md` — are these accepted, rejected, superseded? No agent reading the directory can know without parsing prose. A `proposals/` subdirectory **must include a status field** (front-matter or filename suffix: `PROPOSAL_github_blackboard.accepted.md`).

#### 3b. Duplicated `rules.md` Creates Non-Deterministic Prompt Injection
The duplicate blocks mean that when Optimus injects `rules.md` into an agent prompt, **the same constraint is stated twice at potentially conflicting positions in the context window**. Some LLMs weight later instructions over earlier ones (recency bias). The duplicate is not harmless — it is a context-poisoning bug.

#### 3c. `protocol.md` Encoding Bug (Critical)
The UTF-16LE encoding of `protocol.md` is a **silent failure mode**. An agent reading it in UTF-8 mode will see: `# O p t i m u s B l a c k b o a r d P r o t o c o l`. The document will be parsed as valid Markdown with heavily degraded semantics. This must be re-saved as UTF-8 immediately, independent of any restructuring.

#### 3d. Mixed ID Schemes in `tasks/` and `reviews/`
UUIDs (`4f56ed52-343e...`) and Unix timestamps (`1773103648932`) coexist. This means:
- You cannot sort tasks by creation time using filenames alone (UUID has no time component).
- You cannot guarantee uniqueness across engines (timestamps collide in <1ms; UUIDs don't).

**Fix:** Standardize on ULIDs (lexicographically sortable + globally unique) or `<ISO8601>_<role>_<slug>.md` for human readability.

---

### 4. Security Risks

#### 4a. Unconditional `--dangerously-skip-permissions` (HIGH RISK)
`delegate.js` hardcodes `--dangerously-skip-permissions` for every Claude Code invocation:
```js
cliArgs = ['@anthropic-ai/claude-code', '--print', '--dangerously-skip-permissions', '-p', prompt];
```
This flag disables Claude Code's built-in safety guardrails **for all tasks, unconditionally**. There is no per-task override, no allowlist, no task-sensitivity classification. A delegated task that should be read-only (e.g., a code review) gets the same unrestricted file-system permissions as a task that should write code.

**Fix:** Remove the hardcoded flag. Pass it only when the calling orchestrator explicitly opts in via a `--allow-dangerous` flag to `delegate.js` itself, with the task ID logged.

#### 4b. Shell Argument Prompt Injection
```js
const prompt = args[1];
// ...
cliArgs = [..., '-p', prompt];
```
`prompt` is taken directly from `process.argv` and injected as a CLI argument with `shell: true`. An adversarially crafted task description containing shell metacharacters (`;`, `&&`, `` ` ``, `$()`) can break out of the argument boundary and execute arbitrary shell commands on the host. The `shell: true` option is the specific enabler here.

**Fix:** Use `shell: false` (the default for `spawnSync`/`spawn`). Pass args as an array — not a shell string — to prevent interpolation entirely.

#### 4c. No `.gitignore` Boundary on `.optimus/`
There is no evidence that `.optimus/` is git-ignored. If it is committed, `rules.md` exposes the GitHub account name, agent architecture, swarm topology, and internal operational protocols. More critically, `tasks/*.md` may contain PII, API keys extracted during debugging, or security-sensitive code snippets that were processed by agents.

**Fix:** Ensure `.optimus/` (or at minimum `tasks/`, `reviews/`, `reports/`) is listed in `.gitignore`. Commit only `rules.md`, `protocol.md`, and `personas/` if desired for team sharing.

---

### 5. Async Race Conditions

| Scenario | Condition | Failure Mode |
|----------|-----------|--------------|
| Two workers read `TODO.md` simultaneously | Both find task #3 as first `[ ]` | Both execute task #3; one or both produce partial artifacts; second writer's `[x]` marks overwrites the first's full update |
| Worker crashes after starting but before writing `[x]` | Process kill, OOM, API timeout | Task stays `[ ]` forever; no re-queue; zombie artifact in `tasks/` |
| Orchestrator calls `delegate.js` for parallel reviews | `spawnSync` blocks | Reviews run serially despite appearing parallel; wallclock time is sum, not max |
| `runtime-prompts/` written by multiple agents | No naming collision prevention | Timestamp dirs may collide within same millisecond on fast hardware |

---

### 6. Critique of the Proposal's Recommendations

**Q1: Proposals → `proposals/`** ✅ Accept — correct, but add lifecycle status (draft/accepted/rejected) to filenames or front-matter.

**Q2: Stray JS scripts → `scripts/`** ⚠️ Partial — moving files solves clutter but does NOT fix `delegate.js`'s synchronous execution model or the `--dangerously-skip-permissions` hardcoding. Moving a security risk into a subdirectory doesn't remediate it.

**Q3: Core rules → `config/`** ✅ Accept — centralize as `config/rules.md`, `config/protocol.md`, `config/memory.md`. But fix the UTF-16 encoding and deduplicate `rules.md` first.

**Q4: Shell commands to implement** ⚠️ Insufficient scope — the proposal asks for `mv` commands. What's actually needed is a migration script that also re-encodes `protocol.md`, deduplicates `rules.md`, normalizes task IDs, and adds a `.gitignore` entry.

---

### 7. Recommended Target Structure

```
.optimus/
├── config/                    # Immutable system config (git-tracked if desired)
│   ├── rules.md               # DEDUPLICATED, authoritative rules (UTF-8)
│   ├── protocol.md            # RE-ENCODED to UTF-8
│   └── memory.md              # Agent long-term memory seed
│
├── personas/                  # Role definitions (git-tracked)
│   ├── architect.md
│   └── qa-engineer.md
│
├── registry/                  # Agent/model manifests (git-tracked)
│   ├── available-agents.json
│   └── available-models.json
│
├── proposals/                 # All proposals with lifecycle status
│   ├── PROPOSAL_github_blackboard.draft.md
│   ├── PROPOSAL_SCM_MCP.draft.md
│   └── PROPOSAL_directory_structure.draft.md
│
├── tasks/                     # Per-task state files (gitignored)
│   └── <ULID>_<role>_<slug>.md
│
├── reviews/                   # Review artifacts (gitignored)
│   └── <ULID>_<role>_review.md
│
├── reports/                   # Scan/diagnostic reports (gitignored)
│   └── architect_path_scan_report.md
│
├── runtime-prompts/           # Ephemeral prompt payloads (gitignored)
│   └── <ULID>/
│
├── scripts/                   # Operational scripts (git-tracked, fixed)
│   ├── delegate.js            # REWRITTEN: async, no shell:true, no hardcoded --dangerously-skip-permissions
│   ├── script-check.js
│   └── test-council.js
│
└── TODO.md                    # Master task queue — or replace with tasks/ state machine
```

**`.gitignore` addition required:**
```
.optimus/tasks/
.optimus/reviews/
.optimus/reports/
.optimus/runtime-prompts/
```

---

### 8. Final Recommendation: **HYBRID**

| Dimension | Verdict | Rationale |
|-----------|---------|-----------|
| Taxonomy restructuring (proposals/, config/, scripts/) | **ACCEPT** | Correct diagnosis, correct taxonomy |
| "Just move the files" as complete solution | **REJECT** | Ignores encoding bug, security flaws, and concurrency model |
| `delegate.js` as-is after move | **REJECT** | `--dangerously-skip-permissions` hardcoded + `shell:true` + `spawnSync` = three independent critical defects |
| TODO.md as sole shared state | **REJECT** | No locking → guaranteed corruption under any parallelism |
| Full restructuring + security + async fixes | **ACCEPT** | Addresses root causes, not just cosmetics |

**Hybrid Action Plan (Priority Order):**
1. 🔴 **Immediate:** Re-encode `protocol.md` to UTF-8. Deduplicate `rules.md`. (Silent failures today.)
2. 🔴 **Immediate:** Rewrite `delegate.js` — remove `shell: true`, remove hardcoded `--dangerously-skip-permissions`, replace `spawnSync` with async `spawn`.
3. 🟡 **Short-term:** Add `.gitignore` entries for `tasks/`, `reviews/`, `reports/`, `runtime-prompts/`.
4. 🟡 **Short-term:** Execute the file taxonomy migration (proposals/, config/, scripts/).
5. 🟢 **Medium-term:** Replace `TODO.md` single-file state with per-task state files using atomic writes, or introduce a lightweight SQLite blackboard for multi-worker coordination.

The proposal is a correct starting point but treats a structural and security problem as a purely cosmetic housekeeping task. The restructuring is necessary but not sufficient.


> [LOG] 
Total usage est:        1 Premium request
API time spent:         1m 48s
Total session time:     1m 54s
Total code changes:     +0 -0
Breakdown by AI model:
 claude-sonnet-4.6       128.8k in, 5.2k out, 114.1k cached (Est. 1 Premium request)