---
id: mem_agent_friendly_errors_20260322
category: user-preference
tags: [error-handling, agent-friendly, documentation, ux-principle]
created: 2026-03-22T10:44:00.000Z
---
## User Preference: All Errors & Docs Must Be Agent-Friendly

All error messages and documentation across the entire Optimus codebase must be **agent-friendly** — designed for consumption by AI agents, not just humans.

**Error response pattern** (established in v2.16.7):
```json
{ "error": { "code": "<machine_readable>", "message": "<human_readable>", "fix": "<concrete_recovery_steps>" } }
```

Rules:
1. Every error MUST include a machine-readable `code` (snake_case)
2. Every error MUST include a `fix` field with actionable recovery steps
3. Recovery steps must be concrete — list specific commands, config paths, env vars
4. Documentation (SKILL.md, system-instructions) must include troubleshooting sections
5. New error paths must be classified — never let errors fall through to generic `internal_error` without guidance

This applies to: HTTP runtime, MCP tools, ACP adapter, worker-spawner, and any future error surfaces.

---
id: mem_copilot_acp_auth_20260322
category: architecture
tags: [copilot, acp, authentication, gh-cli, engine-auth]
created: 2026-03-22T10:57:00.000Z
---
## GitHub Copilot ACP Authentication Mechanism

Copilot ACP (`copilot --acp`) uses the **`gh` CLI auth context**, NOT environment variables.

- Auth is stored in `~/.config/gh/hosts.yml`, managed by `gh auth login`
- The `copilot --acp` child process inherits the `gh` CLI session automatically
- **Do NOT use** `GH_TOKEN` or `GITHUB_TOKEN` env vars for Copilot ACP auth
- `.env` `GITHUB_TOKEN` is for **Optimus's own GitHub API operations** (issues, PRs, repo access) — completely separate

**Setup:** `gh auth login` → verify with `gh auth status`

**Common mistake:** setting `GH_TOKEN=$(gh auth token)` before starting the runtime. This works but is unnecessary — `copilot --acp` reads `gh` config directly. If `GH_TOKEN` is set, it may override the `gh` config and cause issues when the token expires.

**Claude Code** is different: uses `claude login` or `ANTHROPIC_API_KEY` env var.

---
id: mem_1773295993057_419
category: feature-completion
tags: [write_blackboard_artifact, mcp-tool, security, symlink, plan-mode]
created: 2026-03-12T06:13:13.056Z
---
## write_blackboard_artifact MCP Tool — Completed 2026-03-12

Merged as `87b767e` on master (PR #123, Issue #121).

Enables plan-mode agents to write files to `.optimus/` only. Two-layer security:
1. Lexical `startsWith(optimusRoot + path.sep)` — prevents `..` and sibling bypass
2. `fs.realpathSync()` on existing path prefix — prevents symlink traversal

Key lesson: `path.resolve()` and `path.normalize()` do NOT resolve symlinks. Always use `fs.realpathSync()` when validating paths against symlink-based escapes. The reviewer caught this as P0 — the initial implementation only had the lexical check.

Content validation uses `=== undefined || === null` (not `!content`) to allow empty strings.

---
id: mem_vcs_json_wipe_20260312
category: bug-postmortem
tags: [upgrade, config-wipe, vcs.json, ado, cache-invalidation]
created: 2026-03-12
---
## vcs.json Config Wipe Bug — Postmortem 2026-03-12

`optimus upgrade` force-overwrote `.optimus/config/vcs.json`, wiping user's ADO organization and project values.
Root causes: (1) upgrade used overwrite instead of merge (2) AdoProvider static cache prevented recovery (3) git-not-in-PATH error was silently swallowed.

Lessons:
- ALWAYS deep-merge user config files during upgrade, never overwrite
- Static caches of disk-read config MUST have invalidation
- Never swallow errors from `execSync` — provide actionable fallback messages
- Test upgrade paths with real user data, not empty directories

---
id: mem_1773496578070_806
category: feature-completion
tags: [multi-level-memory, memory-system, append_memory, MemoryManager, OPTIMUS_CURRENT_ROLE, worker-spawner]
created: 2026-03-14T13:56:18.070Z
---
## Multi-Level Memory System — Completed 2026-03-14

Merged as PR #376 on master (Issue #375).

Upgraded memory from single flat file to hierarchical system: project-level (`continuous-memory.md`) and role-level (`memory/roles/{role}.md`). New `MemoryManager.ts` in `src/managers/` owns all parsing, scoring, loading, and migration.

Key lessons:
1. `loadProjectMemory()` was in `worker-spawner.ts`, NOT `mcp-server.ts` — the solution spec had the wrong file location. Always verify file locations with codebase exploration before designing.
2. `OPTIMUS_CURRENT_ROLE` env var did NOT exist before this feature — it had to be added to `extraEnv` in worker-spawner.ts:1235. Never assume env vars exist without verifying.
3. The code-explorer council correctly identified both issues above, saving a failed implementation attempt.
4. Council dispatches (code-architect, code-reviewer) experienced API 500/400 errors — PM fell back to direct review. Non-blocking council dispatch (`dispatch_council_async`) may be more resilient to transient errors.

---
id: mem_1773526168196_yt4dnv
date: 2026-03-14T22:09:28.196Z
level: project
category: architecture-decision
tags: [context-continuity, list-knowledge, mcp-tool, council-fallback, path-security]
author: pm
---
## Context Continuity System — Completed 2026-03-15

Merged as PR #386 on master (Issue #381).

Implemented three-layer context continuity: (1) `list_knowledge` MCP tool for metadata-only discovery of .optimus/ artifacts, (2) Context Check step 6 in Delegation Pre-Flight Pipeline, (3) sub-agent self-discovery hint in basePrompt.

Key lessons:
1. Architect and reviewer councils both hit API 500/400 errors during this feature. PM conducted direct review as fallback. This confirms the memory entry from #375 — `dispatch_council_async` may be more resilient, and PM should always be prepared to review directly when councils fail.
2. `list_knowledge` uses dual-layer path validation (lexical startsWith + fs.realpathSync) matching the `write_blackboard_artifact` pattern. The code-explorer correctly identified this requirement — lexical-only validation was caught as insufficient.
3. `.optimus/config/system-instructions.md` changes don't appear in git diff because `.optimus/config/` is gitignored (local config). Only `optimus-plugin/scaffold/config/` is tracked. This is correct behavior but should be documented for future devs.
4. The `contextHint` code in `delegate_task_async` (mcp-server.ts:650) is marked for removal after one release cycle. TODO comment added with date 2026-03-15.

---
id: mem_1773526506329_27u7fb
date: 2026-03-14T22:15:06.329Z
level: project
category: architecture-decision
tags: [user-memory, architecture, memory-system]
author: pm
---
User-Level Cross-Project Memory uses a SEPARATE subsystem from project/role memory. Key design: plain Markdown bullets (not YAML frontmatter), own loader function (loadUserMemory), own safety filter (validateUserMemoryContent), read-time sanitization via sanitizeExternalContent(). Storage at ~/.optimus/memory/user-memory.md. Opt-in via optimus memory init. 6 new functions added to MemoryManager.ts. Do NOT mix user memory into MemoryEntry parsing/scoring pipeline.

---
id: mem_1773538468099_110ftc
date: 2026-03-15T01:34:28.099Z
level: project
category: architecture-decision
tags: [task-dependencies, delegate-task-async, architecture, TaskManifestManager, council-runner, race-condition]
author: pm
---
## Task Dependencies for delegate_task_async — Completed 2026-03-15

Merged as PR #401 on master (Issue #395).

Implemented declarative task dependencies: `depends_on` parameter on `delegate_task_async` with `blocked` status, synchronous `unblockDependents()` in TaskManifestManager, and centralized `spawnAsyncWorker()` helper.

Key lessons:
1. Code-reviewer council hit API 500/400 errors (3 of 3 reviewers failed). PM fell back to direct review — consistent with prior memory entries from #375 and #381. Council API reliability remains a recurring issue.
2. The `updateTask()` method uses `withManifestLock()` which is async and not awaited by callers. For dependency-critical transitions, `unblockDependents()` was made fully synchronous (like `createTask`) to prevent double-spawn races. This is a pattern to follow for any future manifest mutations that must be atomic.
3. `spawnAsyncWorker()` was extracted from 2 duplicated inline `spawn()` calls in mcp-server.ts. Placed in council-runner.ts (exported) to avoid circular imports (mcp-server already imports from council-runner). The helper uses `path.join(__dirname, 'mcp-server.js')` since `__filename` in council-runner resolves to council-runner.js, not the entry point.
4. Dev agent's output report was minimal (missing detailed ## Test Results section). PM should include an explicit instruction in task_description: "Your output report MUST include a ## Test Results section with build exit code, git diff --stat, and pass/fail verdict."
5. `blocked` status is NOT handled by `reapStaleTasks` or meta-cron — this is intentional for v1 but should be addressed in v2 as a hygiene concern.

v2 backlog items: circular dependency detection, blocked-task reaper, depends_on for dispatch_council_async.

---
id: mem_1773539210644_rca3sy
date: 2026-03-15T01:46:50.644Z
level: project
category: architecture-decision
tags: [meta-cron, session-persistence, agent-id, scaffold, architecture]
author: pm
---
## Meta-Cron Session Persistence — Completed 2026-03-15

Merged as PR #402 on master (Issue #399, fixes #398).

Implemented session persistence for meta-cron agents: `CronEntry.last_agent_id` stores the T1 agent ID, `fire()` passes it to task creation, worker-spawner backfills it to task manifest after T1 finalization, and meta-cron reads it back after task completion.

Key lessons:
1. **Manifest-based agent_id recovery over filesystem scan**: Code-explorer council correctly flagged that scanning `.optimus/agents/{role}_*.md` by modification time is race-prone and not causally tied to the fired task. Instead, worker-spawner writes `agent_id` to the task manifest record, and meta-cron reads from there — deterministic, task-local.
2. **Skills are scaffolded from `optimus-plugin/skills/`, NOT `optimus-plugin/scaffold/skills/`**: The `upgrade.js` command copies from `pluginRoot/skills/` (line 102-105). Dev agent created the file at wrong path; PM caught and fixed this during review.
3. **`TaskManifestManager.updateTask()` is fire-and-forget**: It uses `withManifestLock()` but doesn't return/await the Promise. However, since all writes go through the same FIFO mutex queue, ordering is preserved. The 30s meta-cron polling gap provides ample time for both writes to complete.
4. **Code-architect council hit API 500 errors (3/3)**: This continues the pattern from Issues #375 and #381. PM conducted direct architectural review as fallback. `dispatch_council_async` may be more resilient for future dispatches.
5. **`_fallbackSessionId` in worker-spawner is the session ID parameter**: For async cron tasks, its value is `async_{taskId}` (set in council-runner.ts:102). This convention enables extracting the taskId for manifest backfill.

---
id: mem_1773540294326_hn00fb
date: 2026-03-15T02:04:54.326Z
level: project
category: architecture-decision
tags: [release-process, skill, scaffold, config-driven, auto-detection]
author: pm
---
## Generic Release-Process Skill — Completed 2026-03-15

Merged as PR #409 on master (Issue #403).

Refactored the release-process skill from Optimus-specific to generic, config-driven. Ships in scaffold (`optimus-plugin/scaffold/skills/release-process/SKILL.md`) — first skill ever included in the scaffold.

Key design decisions:
1. **Flat config schema** over nested objects. 10 fields, all optional: `version_files`, `build_command`, `test_command`, `changelog_file`, `docs_to_update`, `stage_patterns`, `tag_prefix`, `publish_command`, `pre_release_hooks`, `post_release_hooks`. Simple string arrays and strings — no typed objects like `{path, format, key}`.
2. **Auto-detection** when no config exists: package.json → npm, pyproject.toml → Python, Cargo.toml → Rust, otherwise generic. Config always overrides auto-detection.
3. **String-only hooks** (shell commands as string arrays) for v1, not skill references. Keeps it simple — skill-name hooks can be added in v2.
4. **Optimus project config** at `.optimus/config/release-config.json` (gitignored) preserves dual package.json, custom build command, doc list, and stage patterns.
5. **Project-local skill preserved**: `.optimus/skills/release-process/SKILL.md` for the Optimus project was NOT overwritten — it still contains Optimus-specific content (scaffold validation, etc.) and continues to be used by this project.

Key lessons:
1. 2 of 3 async expert tasks timed out at 6+ minutes — consistent with project memory pattern of council/expert API unreliability. PM fell back to direct synthesis using the one completed proposal (workflow-PM).
2. `optimus-plugin/scaffold/skills/` directory did not exist before this change. Skills can now be shipped in the scaffold for the first time.
3. The `upgrade.js` command copies from `pluginRoot/skills/` (per memory from #398). This means existing Optimus users won't get the generic skill automatically via upgrade — they already have a project-local override. New `optimus init` users WILL get it. This is correct behavior.
4. `.optimus/config/` is gitignored, so `release-config.json` never appears in diffs or PRs. This is by design — it's local project config.

---
id: mem_1773542070773_5ac4or
date: 2026-03-15T02:34:30.773Z
level: project
category: bug-postmortem
tags: [mcp-tools, schema, delegate_task_async]
author: pm
---
## Dev agents may add handler code without updating MCP schema (2026-03-15)

When implementing configurable `heartbeat_timeout_ms` for delegate_task_async (#407), the dev agent added the parameter extraction and validation logic in the handler but forgot to:
1. Add the field to the MCP tool input schema definition (the `inputSchema.properties` object)
2. Add the import for the new helper function (`loadEngineHeartbeatTimeout`)

Both are easy to miss because the schema definition and handler are 300+ lines apart in mcp-server.ts. PM caught this during manual review.

**Lesson:** After any dev delegation that adds MCP tool parameters, always verify BOTH the schema definition AND the handler code independently. The schema is typically at lines 200-500, while handlers are at 600+.

---
id: mem_1773542083264_sa0ob0
date: 2026-03-15T02:34:43.264Z
level: project
category: architecture-decision
tags: [timeout, configurable, heartbeat, delegate_task_async, meta-cron]
author: pm
---
## Configurable heartbeat timeouts — resolution order (2026-03-15, #407)

Task heartbeat timeouts are now configurable with 3-tier resolution:
1. Explicit `heartbeat_timeout_ms` param on `delegate_task_async`
2. Engine config `timeout.heartbeat_ms` in `available-agents.json`
3. Hardcoded fallback: 180,000ms (3 min)

Key design decisions:
- **Resolve BEFORE createTask()** — never backfill via updateTask() (fire-and-forget race)
- **Reject invalid values** — no clamping (matches project validation pattern)
- **Only delegate_task_async** — sync delegate_task has no watchdog lifecycle
- **Naming: heartbeat_timeout_ms** — not "timeout_ms" because it's heartbeat staleness, not wall-clock
- **Max cap: 30 minutes** — prevents truly runaway resource retention
- Meta-cron: `startup_timeout_ms` on CronEntry (max 10 min)

Files: TaskManifestManager.ts, mcp-server.ts, worker-spawner.ts, meta-cron-engine.ts

---
id: mem_1773545392868_pyb1pz
date: 2026-03-15T03:29:52.868Z
level: project
category: architecture-decision
tags: [acp, claude-agent-acp, adapter, testing, mock-server]
author: pm
---
## claude-agent-acp AcpAdapter Compatibility — Completed 2026-03-15

Merged as PR #417 on master (Issue #413, tracking #414).

Added `claude-agent-acp` v0.21.0 as a verified ACP engine. Key finding: **the existing AcpAdapter.ts code was already fully compatible** — no code changes needed beyond the JSDoc comment. The adapter's session/new (`cwd` + `mcpServers`), session/prompt (array format), and streaming (`agent_message_chunk`) handling all matched claude-agent-acp's protocol.

Key changes:
1. **Mock server dual-mode framing**: `test-ipc/mock-acp-server.js` now supports both Content-Length and NDJSON framing. Auto-detects from first incoming data chunk, `--ndjson` flag forces NDJSON mode. This was the main implementation work.
2. **Test fixes**: Tests 7-10 had false assertions about stub behavior that didn't exist. Fixed to test actual AcpAdapter behavior. Added test 13 (session resume). 41/41 tests pass.
3. **Engine config**: Added `claude-agent-acp` to `.optimus/config/available-agents.json` (gitignored local config, not scaffold).
4. **Notification format**: Mock server updated to use `params.update.sessionUpdate: 'agent_message_chunk'` wrapper matching ACP protocol spec.

Lesson: The mock server was the bottleneck, not the adapter. When adding new ACP engine support, the mock server must match the framing the adapter uses (NDJSON), not just the protocol messages.

---
id: mem_1773547586947_detuwz
date: 2026-03-15T04:06:26.948Z
level: project
category: architecture-decision
tags: [competitive-intel, meta-skill, meta-cron, architecture]
author: pm
---
## Competitive Intelligence Feature — Completed 2026-03-15

Merged as PR #427 on master (Issue #419, tracking #420).

Implemented autonomous competitive monitoring as a Meta-Skill + Project Config pattern (NOT a meta-agent):
1. **Skill** (`optimus-plugin/skills/competitive-intel/SKILL.md`): 375-line 7-phase conservative monitoring protocol — ships in scaffold
2. **Config** (`.optimus/config/competitive-watchlist.json`): Project-local watchlist (gitignored) with 5 competitors
3. **Role** (`optimus-plugin/roles/competitive-intel-analyst.md`): T2 role template
4. **Meta-cron** (`daily-competitive-intel`): Daily at 8 AM, 3 dry-run cycles, `review` capability tier

Key design decisions:
- **High precision over high recall** — conservative reporting bias, cool-down windows, significance scoring
- **4-dimension significance scoring** (Magnitude, Novelty, Strategic Fit, Evidence Quality) 0-12 scale
- **Anti-pattern banking** — 6 explicitly banned patterns (alert fatigue, hallucinated intent, generic summaries, stale re-reporting, unbounded research, single-snapshot trends)
- **Session persistence** for cross-cycle trend tracking (star baselines, event fingerprints, trend labels)
- **Scaffold config** ships empty template; project config is local and gitignored

Expert proposals: 1 of 3 completed (prompt-engineering-lead via GPT-5.4/GitHub Copilot). Code-architect (Claude) and DX-expert (GPT-5.4/Claude Code) both timed out at 6+ min. PM synthesized directly — consistent with timeout pattern from Issues #403, #395. The Gemini-backed initial dispatch for prompt-engineering-lead never appeared in manifest (failed silently); re-dispatched via GitHub Copilot/GPT-5.4 successfully.

---
id: mem_1773550061685_5tc5tp
date: 2026-03-15T04:47:41.685Z
level: project
category: competitive-intel-session
tags: [competitive-intel, session-state, baselines]
author: competitive-intel-analyst
---
## Competitive Intel Session State — 2026-03-15 (Run #1, Initial Baseline)

### Per-Competitor Baselines

**AutoGen (microsoft/autogen)**
- last_seen_release: maintenance-only (no new feature releases)
- last_seen_star_count: 55600
- 7d_star_baseline: 55600 (no prior data)
- 30d_star_baseline: 55600 (no prior data)
- last_reported_event_fingerprint: autogen-to-agent-framework-2025-10-02
- last_reported_at: 2026-03-15T04:41:00Z
- open_hypotheses: ["Will a community fork of AutoGen emerge?", "When will microsoft/agent-framework reach 1.0.0 GA?"]
- trend_label: cooling
- last_significant_keywords: ["multi-agent", "orchestration", "graph-workflow", "enterprise"]
- api_note: SAML SSO blocks gh api — use web fetch fallback

**microsoft/agent-framework (NEW — successor to AutoGen)**
- last_seen_release: python-1.0.0rc4 (2026-03-11)
- last_seen_star_count: 7900
- trend_label: unknown (first observation)
- note: Consider adding to watchlist as primary monitored entity replacing AutoGen

**CrewAI (crewAIInc/crewAI)**
- last_seen_release: 1.10.2rc2 (2026-03-14)
- last_seen_star_count: 46088
- 7d_star_baseline: 46088 (no prior data)
- 30d_star_baseline: 46088 (no prior data)
- last_reported_event_fingerprint: none
- last_reported_at: never
- open_hypotheses: []
- trend_label: stable
- last_significant_keywords: []
- config_issue: Watchlist has wrong repo owner (crewAI-inc should be crewAIInc)

**LangGraph (langchain-ai/langgraph)**
- last_seen_release: langgraph 1.1.2 (2026-03-12), CLI 0.4.17 (2026-03-13)
- last_seen_star_count: 26409
- 7d_star_baseline: 26409 (no prior data)
- 30d_star_baseline: 26409 (no prior data)
- last_reported_event_fingerprint: none
- last_reported_at: never
- open_hypotheses: ["What are 'deep agent templates' in PR #7165? Monitor for docs/release notes describing this feature.", "langgraph deploy subcommand — hosted deployment trajectory"]
- trend_label: stable (high shipping velocity but no major feature jump)
- last_significant_keywords: ["deep agent templates", "deploy", "remote graph API"]

**OpenAI Swarm (openai/swarm)**
- last_seen_release: none (no releases published)
- last_seen_star_count: 21156
- 7d_star_baseline: 21156 (no prior data)
- 30d_star_baseline: 21156 (no prior data)
- last_reported_event_fingerprint: swarm-archived-agents-sdk-redirect-2025-03
- last_reported_at: never (baseline only)
- open_hypotheses: []
- trend_label: cooling (effectively archived, no activity since Mar 2025)
- last_significant_keywords: []
- note: README redirects to OpenAI Agents SDK. Consider replacing with openai/openai-agents-python on watchlist.

**MetaGPT (geekan/MetaGPT)**
- last_seen_release: v0.8.2 (2025-03-09)
- last_seen_star_count: 65172
- 7d_star_baseline: 65172 (no prior data)
- 30d_star_baseline: 65172 (no prior data)
- last_reported_event_fingerprint: none
- last_reported_at: never
- open_hypotheses: []
- trend_label: cooling (last commit Jan 2026, last release Mar 2025)
- last_significant_keywords: []

### System-Wide State
- briefs_written_this_cycle: 1 (autogen-agent-framework)
- dispatches_this_cycle: 0
- api_failures: [microsoft/autogen — SAML 403]
- budget_limited_items: none
- watchlist_issues: ["crewAI-inc/crewAI should be crewAIInc/crewAI", "Consider adding microsoft/agent-framework", "Consider replacing openai/swarm with openai/openai-agents-python"]

---
id: mem_1773553009721_k1kma6
date: 2026-03-15T05:36:49.721Z
level: project
category: architecture-decision
tags: [competitive-intel, v2, discovery, architecture]
author: pm
---
## Competitive Intelligence v2 — Design Decisions (2026-03-15, #430, PR #434)

Upgraded from static-watchlist monitoring to autonomous discovery + monitoring. Key decisions:

1. **Four modes, not three**: Added UPGRADE mode (v1→v2 metadata migration) to prevent populated v1 watchlists from accidentally triggering full Bootstrap discovery. Bootstrap only fires on truly empty watchlists.

2. **Candidate Qualification Rubric**: 4×0-2 scored matrix (Domain Overlap, User Overlap, Maturity, Evidence). Auto-add >= 5/8, human review 3-4, reject 0-2. Analogous to the significance scoring matrix but for discovery.

3. **Watchlist mutation protocol**: Agent CAN add `source: "auto-discovered"` entries (capped at `max_auto_competitors`). Agent MUST NOT modify `source: "user"` entries. JSON validation mandatory after every write.

4. **Medium-confidence bootstrap → human review**: When project profile extraction confidence is medium, candidates go to `pending_human_review` instead of being auto-added. Only high-confidence bootstrap auto-seeds.

5. **request_human_input as primary escalation**: All in-cycle escalations use `request_human_input` (transitions to `awaiting_input` status). GitHub issue creation is fallback only for informational/non-blocking notifications.

6. **Single cron entry retained**: `daily-competitive-intel` cron unchanged. Mode routing happens inside the Skill via positive-condition checks on config fields (not inferred from absence).

Council review noted that atomic writes, memory partitioning, and concurrent edit safety are prompt-discipline only (no TypeScript enforcement). This is by design — all Skills in the system are Markdown instructions, not executable code. The same pattern applies to v1.

---
id: mem_1773557600000_run3ci
date: 2026-03-15T08:00:00Z
level: project
category: competitive-intel-session
tags: [competitive-intel, session-state, baselines, run3]
author: competitive-intel-analyst
---
## Competitive Intel Session State — 2026-03-15 (Run #3, Delta Monitoring)

### Per-Competitor Updated State

**AutoGen (microsoft/autogen)**
- last_seen_release: maintenance-only (unchanged — SAML blocked)
- last_seen_star_count: 55600 (SAML blocked — no update)
- trend_label: cooling (unchanged)
- open_hypotheses: ["When will microsoft/agent-framework reach 1.0.0 GA?"]
- note: AutoGen community fork hypothesis DROPPED — no evidence after 2 cycles

**microsoft/agent-framework (NEW — successor to AutoGen)**
- last_seen_release: python-1.0.0rc4 (2026-03-11) — SAML blocked, no update
- last_seen_star_count: 7900 (SAML blocked)
- open_hypotheses: ["When will 1.0.0 GA ship? Watch for web-fetch-accessible announcement."]
- trend_label: unknown (persistent API block)

**CrewAI (crewAIInc/crewAI)**
- last_seen_release: 1.10.2rc2 (2026-03-14) — unchanged from Run #1
- last_seen_star_count: 46098 (+10 from Run #1 baseline)
- 7d_star_baseline: 46088 (Run #1)
- last_reported_event_fingerprint: crewai-rce-cve-codeinterpreter-2026-03-15
- last_reported_at: 2026-03-15T08:00Z
- open_hypotheses: ["When will 1.10.2 stable release with the RCE fix ship?"]
- trend_label: stable
- escalation_issued: GitHub Issue #447 (security escalation to human)
- security_note: F-001 CVE sandbox escape patched in main (fb2323b). NOT in any release as of 2026-03-15.

**LangGraph (langchain-ai/langgraph)**
- last_seen_release: langgraph 1.1.2 (2026-03-12), CLI 0.4.17 (2026-03-13)
- last_seen_star_count: 26419 (+10 from Run #1 baseline)
- 7d_star_baseline: 26409 (Run #1)
- last_reported_event_fingerprint: langgraph-deep-agent-templates-cli-0.4.17-2026-03-13
- last_reported_at: 2026-03-15T08:00Z
- open_hypotheses: ["Specialist #448 investigating createDeepAgent() scope and LangGraph Deploy trajectory", "Does createDeepAgent() have an in-graph API beyond CLI scaffolding?"]
- trend_label: stable (high velocity, now adding deployment-first features — Optimus-adjacent)
- dispatch_issued: GitHub Issue #448

**OpenAI Agents SDK (openai/openai-agents-python)**
- last_seen_release: v0.12.2 (2026-03-14)
- last_seen_star_count: 19994
- 7d_star_baseline: 19994 (first observation this repo)
- trend_label: stable (cadence: ~3 releases/week, incremental)
- config_note: Watchlist still has openai/swarm — update to openai/openai-agents-python

**MetaGPT (geekan/MetaGPT)**
- last_seen_release: v0.8.2 (2025-03-09) — unchanged
- last_seen_star_count: 65186
- last pushed: 2026-01-21
- trend_label: cooling (confirmed 2 cycles)

### System-Wide State (Run #3)
- briefs_written_this_cycle: 0
- dispatches_this_cycle: 1 (#448 — LangGraph deep agent templates)
- human_escalations_this_cycle: 1 (#447 — CrewAI RCE security)
- api_failures: [microsoft/* — persistent SAML 403]
- event_fingerprints_cooldown_until: {"crewai-rce-cve-codeinterpreter-2026-03-15":"2026-03-22","langgraph-deep-agent-templates-cli-0.4.17-2026-03-13":"2026-03-22"}
- watchlist_issues: ["crewAI-inc/crewAI → crewAIInc/crewAI","replace openai/swarm with openai/openai-agents-python","add microsoft/agent-framework"]

---
id: mem_1773615966614_0op6nj
date: 2026-03-15T23:06:06.614Z
level: project
category: architecture-decision
tags: [user-memory, mcp-tool, master-agent, unified-memory]
author: pm
---
## Unified User Memory — get_user_memory MCP Tool (Issue #458, PR #461, 2026-03-16)

Single source of truth: `~/.optimus/memory/user-memory.md`. Sub-agents read it via `loadUserMemory()` in worker-spawner.ts (unchanged). Master Agent reads it via the new `get_user_memory` MCP tool, which routes through the same `loadUserMemory()` function with identical sanitization and framing.

Key decisions:
- Option A (read `~` instruction) rejected: `~` doesn't expand on Windows in LLM file-read calls — silent failure
- Option C (static injection at init) rejected: goes stale, unbounded prompt growth
- Option B (MCP tool) chosen: observable, testable, reuses all existing guards
- Framing (`--- START USER MEMORY ---`) must match sub-agent injection verbatim
- `master-onboarding/SKILL.md` carries a durable committed instruction as fallback; IDE instruction files are gitignored so local-only
- Instruction placement: `get_user_memory` call must be FIRST in the first-action block — LLM compliance drops when buried in lists

---
id: mem_1773619526668_cwgf27
date: 2026-03-16T00:05:26.668Z
level: project
category: competitive-intel-session-state
tags: [competitive-intel, session-state, run-4]
author: competitive-intel-analyst
---
## Competitive Intel Session State — 2026-03-16 (Run #4)

### Per-Competitor Updated State

**AutoGen (microsoft/autogen)**
- last_seen_star_count: 55600 (SAML blocked — no update)
- trend_label: cooling (unchanged — persistent SAML block)

**microsoft/agent-framework**
- last_seen_star_count: 7900 (SAML blocked — no update)
- trend_label: unknown (persistent SAML block)

**CrewAI (crewAIInc/crewAI)**
- last_seen_release: 1.10.2rc2 (2026-03-14, prerelease)
- last_stable_release: 1.10.1 (2026-03-04)
- last_seen_star_count: 46144
- 7d_star_baseline: 46098 (Run #3)
- star_delta_7d: +46 (noise floor)
- last_reported_event_fingerprint: crewai-cve-fix-merged-main-2026-03-16
- last_reported_at: 2026-03-16T08:00Z
- open_hypotheses: ["When will 1.10.2 stable ship with the RCE fix? Monitor daily."]
- trend_label: stable
- security_note: F-001 CVE sandbox escape patched in main (commit 2026-03-15). NOT in rc2 or any stable as of 2026-03-16.
- escalation_comment: Added to Issue #447 on 2026-03-16

**LangGraph (langchain-ai/langgraph)**
- last_seen_release: cli==0.4.18 (2026-03-15)
- last_seen_star_count: 26459
- 7d_star_baseline: 26419 (Run #3)
- star_delta_7d: +40 (noise floor)
- trend_label: stable
- cool_down_active: langgraph-deep-agent-templates-cli-0.4.17-2026-03-13 (expires 2026-03-22)
- open_hypotheses: ["Specialist #448 investigating createDeepAgent() scope and LangGraph Deploy trajectory"]

**OpenAI Agents SDK (openai/openai-agents-python)**
- last_seen_release: v0.12.2 (2026-03-14)
- last_seen_star_count: 20015
- 7d_star_baseline: 19994 (Run #3)
- star_delta_7d: +21 (noise floor)
- trend_label: stable (cadence: ~3 releases/week, incremental)

**MetaGPT (FoundationAgents/MetaGPT)**
- last_seen_release: v0.8.2 (2025-03-09)
- last_seen_star_count: 65219
- last_pushed: 2026-01-21
- trend_label: cooling (confirmed 4 cycles)

**Zeroshot (covibes/zeroshot)**
- last_seen_release: v5.5.0 (2026-02-19)
- last_seen_star_count: 1327
- 7d_star_baseline: 1327 (first observation)
- trend_label: unknown (first cycle)
- open_hypotheses: ["TUI release still WIP — watch for dedicated TUI release announcement"]

**Composio agent-orchestrator (ComposioHQ/agent-orchestrator)**
- last_seen_release: v0.2.0 (2026-03-01)
- last_seen_star_count: 4406
- 7d_star_baseline: 4406 (first observation)
- trend_label: unknown (first cycle)

**Babysitter (a5c-ai/babysitter)**
- last_seen_star_count: 447
- last_pushed: 2026-03-15
- trend_label: unknown (first cycle)

**OpenCastle (etylsarin/opencastle)**
- last_seen_star_count: 13
- last_pushed: 2026-03-15
- trend_label: unknown (first cycle — very small)

**Ruflo (ruvnet/ruflo)**
- last_seen_release: v3.5.15 (2026-03-09)
- last_seen_star_count: 21158
- 7d_star_baseline: 21158 (first observation)
- trend_label: unknown (first cycle)
- note: Claude-native TypeScript swarm orchestration; unexpectedly large star count. Watch one more cycle before briefing.

**TAKT (nrslib/takt)**
- last_seen_star_count: 767
- last_pushed: 2026-03-15
- trend_label: unknown (first cycle)

**DeerFlow (bytedance/deer-flow)**
- last_seen_release: no formal releases
- last_seen_star_count: 30861
- 7d_star_baseline: 30861 (first observation)
- last_pushed: 2026-03-14
- trend_label: unknown (first cycle — high priority)
- last_reported_event_fingerprint: deerflow-first-observation-2026-03-16
- last_reported_at: 2026-03-16T08:00Z
- open_hypotheses: ["Will DeerFlow add MCP/Claude Code integration? That would escalate overlap."]

**AG2 (ag2ai/ag2)**
- last_seen_release: v0.11.2 (2026-02-27)
- last_seen_star_count: 4263
- last_pushed: 2026-03-15
- trend_label: unknown (first cycle)
- note: Latest release 2026-02-27 despite active commits. Semi-regular release cadence.

**Google ADK (google/adk-python)**
- last_seen_release: v1.27.1 (2026-03-13)
- last_seen_star_count: 18381
- 7d_star_baseline: 18381 (first observation)
- last_pushed: 2026-03-15
- trend_label: accelerating (weekly releases, Google backing)
- last_reported_event_fingerprint: google-adk-a2a-interceptors-v1.27.0-2026-03-16
- last_reported_at: 2026-03-16T08:00Z
- open_hypotheses: ["Will ADK add MCP native tooling or IDE integration (Claude Code/Cursor)?"]

### System-Wide State (Run #4)
- briefs_written_this_cycle: 3 (CrewAI CVE update, Google ADK, DeerFlow)
- dispatches_this_cycle: 0
- human_escalations_this_cycle: 1 (comment on #447 — CrewAI CVE fix status)
- api_failures: [microsoft/* — persistent SAML 403]
- event_fingerprints_cooldown:
  - crewai-rce-cve-codeinterpreter-2026-03-15: expires 2026-03-22
  - langgraph-deep-agent-templates-cli-0.4.17-2026-03-13: expires 2026-03-22
  - crewai-cve-fix-merged-main-2026-03-16: expires 2026-03-23
  - google-adk-a2a-interceptors-v1.27.0-2026-03-16: expires 2026-03-23
  - deerflow-first-observation-2026-03-16: expires 2026-03-23


---
id: mem_1773903387338_6nhg9w
date: 2026-03-19T06:56:27.338Z
level: project
category: release-workflow
tags: [git, windows, release, workspace-hygiene]
author: unknown
---
On Windows, an untracked repo-root file literally named 'nul' makes 'git add -A' fail with 'invalid path'. For release staging in this repo, prefer 'git add -u' plus explicit 'git add' for new files, and force-add .optimus artifacts because .optimus is ignored.

---
id: mem_1773961853163_1ji5o9
date: 2026-03-19T23:10:53.163Z
level: project
category: workflow
tags: [patrol, health-log, issue-300]
author: patrol-manager
---
Hourly patrol Run #198 completed with health summary comment posted to GitHub Issue #300 after the report and ledger were updated. The report file .optimus/reports/cron-hourly-patrol-2026-03-19.md now correctly matches the completed external action.

---
id: mem_1773968876484_03da2w
date: 2026-03-20T01:07:56.484Z
level: project
category: workflow
tags: [patrol, run-200, runtime-finalization]
author: patrol-manager
---
Hourly patrol Run #200 wrote .optimus/reports/cron-hourly-patrol-2026-03-20.md and posted a health-log comment to Issue #300. Observation changed from duplicate-launch suspicion to runtime finalization drift: the 01:00Z tick produced one fresh patrol task, but older 00:00Z cron manifest entries for patrol and daily competitive-intel still remained in running state without heartbeat updates.

---
id: mem_1773972488766_zggpd3
date: 2026-03-20T02:08:08.766Z
level: project
category: workflow
tags: [patrol, run-201, council-partial]
author: patrol-manager
---
Hourly patrol Run #201 detected new issues #507 and #508. Patrol triaged #507 as P3 and #508 as P2, added system-maintained to both, and posted a partial-council status comment to #508 because manifest task council_1773971064905_z8gsvt finished partial with 2 of 5 workers failed. Runtime finalization drift remains the operative hypothesis because run #200 verified normally while run #199 and the 00:00Z daily competitive-intel task still show running.

---
id: mem_1773976387480_gxqs1x
date: 2026-03-20T03:13:07.480Z
level: project
category: workflow
tags: [patrol, meta-cron, runtime-finalization-drift, stale-running]
author: patrol-manager
---
Hourly patrol Run #202 escalated the prior runtime-finalization-drift observation into a direct patrol action. Manifest tasks cron_hourly-patrol_1773964811380_orpopw (Run #199) and cron_daily-competitive-intel_1773964811408_qknh5w (daily competitive-intel Run #4) remained in running state for more than 2 hours with frozen heartbeat timestamps near 00:00Z, while newer patrol tasks progressed normally. Patrol marked both manifest entries failed, updated patrol-ledger.json to Run #202, and posted health summary comment 4095150707 to Issue #300.

---
id: mem_1773979459047_kfffrx
date: 2026-03-20T04:04:19.047Z
level: project
category: workflow
tags: [patrol, hourly-patrol, issue-triage, run-203]
author: patrol-manager
---
Hourly patrol Run #203 found no new stuck-running tasks after Run #202 cleared the stale 00:00Z entries. The only direct action this cycle was triaging newly opened Issue #509 by adding labels P3 and system-maintained. Inventory at patrol time: 41 open issues, 0 open PRs, 0 stale merged remote branches, and one active running task (the current patrol). Health summary comment 4095334424 was posted to Issue #300.

---
id: mem_1774604408497_ftmfws
date: 2026-03-27T09:40:08.497Z
level: project
category: workflow
tags: [optimus-go, install, upgrade, release]
author: unknown
---
`optimus go` has TWO install paths:
1. Lightweight CLI-only install (~25KB): `irm https://raw.githubusercontent.com/cloga/optimus-code/master/scripts/install-cli-remote.ps1 | iex` — installs only `optimus go` to `~/.optimus/cli/`, no roles/agents/skills/dist. Local variant: `.\scripts\install-cli.ps1`.
2. Full workspace upgrade: `npx github:cloga/optimus-code#v{version} upgrade` — upgrades the entire `.optimus/` workspace including MCP configs, launchers, and project registry.

When releasing a new version that changes `go.js`, `go-clients.js`, `project-registry.js`, or `cli.js`, BOTH install scripts (`scripts/install-cli.ps1` and `scripts/install-cli-remote.ps1`) must be updated to include any new file dependencies. The lightweight installer copies specific files by name — it does NOT copy the whole directory.

Multi-CLI support (v2.16.24+): `optimus go` supports `--cli copilot` and `--cli claude` with per-project preference (`preferredCli` in `~/.optimus/projects.json`) and global default (`defaults.cli`). Resolution order: `--cli` flag > project `preferredCli` > global `defaults.cli` > hardcoded `copilot`.

---
id: mem_1774858737021_k6akrs
date: 2026-03-30T08:18:57.021Z
level: project
category: bug-fix
tags: [copilot-cli, mcp, vscode, bug-fix, windows]
author: unknown
---
Copilot CLI 1.0.13+ auto-discovers `.vscode/mcp.json` in the project directory (in addition to `~/.copilot/mcp-config.json` and `--additional-mcp-config`). However, Copilot CLI does NOT resolve VS Code's `${workspaceFolder}` variable — it treats it as a literal string, causing `Connection closed` / ENOENT. Therefore, ALL generated MCP configs (including `.vscode/mcp.json`) must use absolute paths, not `${workspaceFolder}` or relative `./`. This was fixed in v2.17.4 by making `renderString()` in `mcp-config.js` always resolve to absolute paths via `path.join(workspaceRoot, ...)`. These files are gitignored so absolute paths don't affect other users.

---
id: mem_1774924419537_o10vt2
date: 2026-03-31T02:33:39.537Z
level: project
category: bug-fix
tags: [build, mcp, delegation, copilot]
author: unknown
---
Fixed delegated Copilot regression by syncing fresh optimus-plugin/dist bundles into workspace .optimus/dist during repo builds. Nested delegated MCP sessions launch .optimus/dist/mcp-server.js via .optimus/config/mcp-servers.json, so stale workspace dist can keep old auth/runtime bugs alive even after rebuilding optimus-plugin/dist.

---
id: mem_1775001600000_run11ci
date: 2026-04-03T08:00:00Z
level: project
category: competitive-intel-session
tags: [competitive-intel, session-state, baselines, run11]
author: competitive-intel-analyst
---
## Competitive Intel Session State — 2026-04-07 (Run #14)

### Mode: DISCOVERY + MONITOR (Monday; discovery_day=Monday; last discovery > 6 days ago)

### Per-Competitor Updated State

**CrewAI (crewAIInc/crewAI)**
- last_seen_release: 1.13.0 (2026-04-02, stable)
- last_seen_star_count: 48,173
- 7d_star_baseline: 48,104 (Run #13)
- last_reported_event_fingerprint: crewai-1.13.0-stable-a2ui-2026-04-03
- last_reported_at: 2026-04-03T08:00Z
- open_hypotheses: ["Will A2UI gain a third adopter? (after CrewAI + AG2)", "Will 1.14.0 add MCP-native tooling?"]
- trend_label: stable

**DeerFlow (bytedance/deer-flow)**
- last_seen_star_count: 58,612
- 7d_star_baseline: 58,231 (Run #13)
- star_delta_3d: +381 (+0.65%) — decelerating, cool-down expired today
- weekly_extrapolated: ~889 (+1.5%) — BELOW 3% threshold
- cool_down_active: EXPIRED today
- trend_label: decelerating (was accelerating; now dropping below brief threshold)

**Google ADK (google/adk-python)**
- last_seen_release: v1.28.1 stable; v2.0.0a2 pre-release (2026-03-27)
- last_seen_star_count: 18,781
- cool_down_active: EXPIRED today; no new release; stars +19 = noise
- trend_label: stable (weekly releases, Google backing)
- open_hypotheses: ["Will ADK v2.0.0 go beta or GA? v2.0.0a2 exists since 2026-03-27."]

**OpenAI Agents SDK (openai/openai-agents-python)**
- last_seen_release: v0.13.5 (2026-04-06) — callable approval policies for local MCP servers + flush_traces API
- last_seen_star_count: 20,613
- last_reported_event_fingerprint: openai-agents-sdk-callable-mcp-approval-v0.13.5-2026-04-07
- last_reported_at: 2026-04-07T00:00Z
- cool_down_active: expires 2026-04-14
- open_hypotheses: ["Will callable approval policies expand to remote/hosted MCP servers in v0.14.0?"]
- trend_label: stable (consistent shipping)

**LangGraph (langchain-ai/langgraph)**
- last_seen_release: 1.1.6 (2026-04-03)
- last_seen_star_count: 28,542
- last_reported_event_fingerprint: langgraph-v1.1.5-remote-build-2026-04-06
- last_reported_at: 2026-04-06T00:00Z
- cool_down_active: expires 2026-04-13
- open_hypotheses: ["Will remote build lead to A2A/LangGraph Cloud convergence?"]
- trend_label: stable

**Vibe Kanban (BloopAI/vibe-kanban)**
- last_seen_release: v0.1.41-20260403 (2026-04-03)
- last_seen_star_count: 24,498
- trend_label: stable (active pre-release cadence)

**Coder Mux (coder/mux)**
- last_seen_release: v0.22.0 stable
- last_seen_star_count: 1,605
- cool_down_active: expires 2026-04-09
- trend_label: stable

**Superset (superset-sh/superset)**
- last_seen_release: desktop-v1.4.7 (2026-04-03); desktop-canary pushed 2026-04-06
- last_seen_star_count: 8,763
- last_reported_event_fingerprint: superset-v1.4.7-agent-registry-2026-04-06
- last_reported_at: 2026-04-06T00:00Z
- cool_down_active: expires 2026-04-13
- open_hypotheses: ["Will custom agent CRUD surface in UI in v1.4.8?"]
- trend_label: accelerating

**Ruflo (ruvnet/ruflo)**
- last_seen_release: v3.5.59 (2026-04-06) — 314 MCP tools, 60+ agent types, 22 plugins, 291 tests
- last_seen_star_count: 30,366
- 7d_star_baseline: 30,095 (Run #13)
- last_reported_event_fingerprint: ruflo-v3.5.59-platform-scale-2026-04-07
- last_reported_at: 2026-04-07T00:00Z
- cool_down_active: expires 2026-04-14
- open_hypotheses: ["Will v3.6.0 introduce MCP marketplace or multi-model broker features?"]
- trend_label: accelerating (5th consecutive cycle of growth; v3.5.59 hardening milestone)

**1Code (21st-dev/1code)**
- last_seen_star_count: 5,382
- last_pushed: 2026-03-06 (now 32 days inactive)
- recommended_removal: true (set Run #11)
- trend_label: cooling

**AG2 (ag2ai/ag2)**
- last_seen_release: v0.11.5 (2026-04-04)
- last_seen_star_count: 4,369
- last_reported_event_fingerprint: ag2-v0.11.5-cli-a2uiagent-2026-04-06
- last_reported_at: 2026-04-06T00:00Z
- cool_down_active: expires 2026-04-13
- open_hypotheses: ["When do AG2 beta features promote to stable?", "A2UI convergence — watching for third adopter."]
- trend_label: accelerating

**Composio (ComposioHQ/agent-orchestrator)**
- last_seen_star_count: 5,810
- last_release: v0.2.2 (dep bump, 03-29)
- trend_label: stable

**Oh My OpenAgent (code-yeongyu/oh-my-openagent)**
- last_seen_release: v3.15.3 (2026-04-06); 3 releases in 2 days (v3.15.1/2/3)
- last_seen_star_count: 48,864
- 7d_star_baseline: 48,600 (Run #13 add)
- dispatch_active: Issue #556 (task_1775520476533_z8fx3g) — delegate-task convergence analysis
- cool_down_active: expires [pending dispatch result — no brief written; dispatch taken instead]
- open_hypotheses: ["Is 'delegate-task' terminology convergence architectural or coincidental?", "Boulder state = Optimus task object? Atlas = Optimus task registry?"]
- trend_label: accelerating (rapid release cadence, architectural depth expanding)

**Emdash (generalaction/emdash)**
- last_seen_release: v0.4.47 (2026-04-06) — Automations beta badge, Forge provider
- last_seen_star_count: 3,698
- trend_label: stable (active development)

**Oh My Codex (Yeachan-Heo/oh-my-codex)**
- last_seen_release: v0.11.13 (2026-04-04)
- last_seen_star_count: 17,454
- 7d_star_baseline: 16,600 (Run #13 add)
- star_delta: +854 (+5.1%) — decelerating from +13k/wk viral (no brief threshold crossed)
- trend_label: decelerating from viral peak (still growing but slowing)

### New Entries (Discovery Run #3 — 2026-04-07)
- **builderz-labs/mission-control** (score 8/8, 3.8k stars) — self-hosted agent orchestration platform
- **abhi1693/openclaw-mission-control** (score 6/8, 3.5k stars) — OpenClaw-based agent management dashboard
- **SmythOS/sre** (score 5/8, 1.25k stars) — cloud-native agent runtime environment

### System-Wide State (Run #14)
- briefs_written_this_cycle: 2 (openai-agents-sdk-callable-mcp-approval-v0.13.5, ruflo-v3.5.59-platform-scale)
- dispatches_this_cycle: 1 (oh-my-openagent-v3.15.x-delegate-task-convergence, Issue #556)
- human_escalations_this_cycle: 0
- api_failures: [] (no failures this cycle)
- watchlist_mutations: +3 auto-discovered (builderz, openclaw-mission-control, smythos-sre); cap now 10/10
- strategic_signal: OpenAI Agents SDK ships callable MCP approval policies — may establish a developer expectation standard for fine-grained orchestration control that Optimus should address. Oh My OpenAgent v3.15.x uses identical "delegate-task" terminology as Optimus internal APIs — possible paradigm convergence signal, dispatched for specialist analysis.
- discovery_state:
  - last_discovery_run: 2026-04-07T00:00Z
  - queries_executed: ["multi-agent AI orchestration TypeScript", "coding agent MCP orchestration TypeScript", "task delegation agent framework"]
  - candidates_evaluated: 17
  - candidates_added: 3
  - rejected_fingerprints_added: ["jayminwest/overstory", "truffle-ai/dexto"]
- event_fingerprints_cooldown:
  - crewai-1.13.0-stable-a2ui-2026-04-03: expires 2026-04-10
  - openai-agents-sdk-callable-mcp-approval-v0.13.5-2026-04-07: expires 2026-04-14
  - coder-mux-v0.22.0-agent-browser-2026-04-02: expires 2026-04-09
  - ag2-v0.11.5-cli-a2uiagent-2026-04-06: expires 2026-04-13
  - superset-v1.4.7-agent-registry-2026-04-06: expires 2026-04-13
  - langgraph-v1.1.5-remote-build-2026-04-06: expires 2026-04-13
  - ruflo-v3.5.59-platform-scale-2026-04-07: expires 2026-04-14


---
id: mem_acp_path_resolution
date: 2026-04-03T09:47:00.000Z
level: project
category: architecture-decision
tags: [acp, engine, path, troubleshooting, mcp-server]
author: system
---
ACP engine "executable not found" is caused by PATH inheritance from the MCP server's launcher process. The MCP server (Node.js subprocess) inherits the PATH that existed when the host (VS Code/Copilot CLI) was started. If ACP tools were installed after the host started, or the host has a restricted PATH, the executables won't be found. Fix: restart host, use absolute paths in available-agents.json, or rely on acpPathResolver.ts which scans common install locations (C:\.tools\.npm-global, %APPDATA%\npm, /usr/local/bin, /opt/homebrew/bin) as fallback. This is the permanent architectural fix implemented in PR for Issue #555.
---
id: mem_1775274992961_bcte7a
date: 2026-04-04T03:56:32.961Z
level: project
category: bug-fix
tags: [copilot, acp, authentication, classic-pat, dotenv, bug-fix]
author: unknown
---
## Copilot ACP Auth — Corrected Understanding (2026-04-04)

Previous memory entry `mem_copilot_acp_auth_20260322` was WRONG. Corrected facts:

- Copilot CLI uses its own credential store (from `copilot login` or gh CLI OAuth)
- Copilot ACP child processes CAN access the credential store — they DO NOT need env tokens
- **BUT**: if `GITHUB_TOKEN` contains a classic PAT (`ghp_`), Copilot tries to use it INSTEAD of the credential store, fails with "Authentication required", and does NOT fall back
- Fix: `sanitizeCopilotAuthEnv` must delete only classic PATs (`ghp_` prefix), keep OAuth (`gho_`) and fine-grained (`github_pat_`) tokens
- The `.env` file loads `GITHUB_TOKEN=ghp_...` via dotenv — this is for Optimus GitHub API, NOT for Copilot auth
- `.optimus/dist/mcp-server.js` must be synced after build — it's the file actually loaded by the MCP server (not `optimus-plugin/dist/`)

---
id: mem_1775437674165_jcqwpt
date: 2026-04-06T01:07:54.165Z
level: project
category: competitive-intel
tags: [competitive-intel, discovery, watchlist, weekly-cron]
author: unknown
---
## Competitive Monitor State — 2026-04-08 (Run #15)

### Last Discovery: 2026-04-07 (Run #14, Monday) — 3 new entries added (builderz-labs/mission-control 8/8, openclaw-mission-control 6/8, SmythOS/sre 5/8)

### Watchlist Status After Run #15
- Total entries: 25
- Auto-discovered: 10/10 (at cap)
- Flagged for removal: `21st-dev/1code` (recommended_removal=true, 30+ days inactive) — human action needed to free slot
- MetaGPT: No release in 12+ months — candidate for recommended_removal next cycle

### Active Cool-downs (expires)
- CrewAI 1.14.0 checkpointing+executor-refactor: 2026-04-15
- OpenAI Agents SDK v0.13.5 callable-MCP-approval: 2026-04-14
- Ruflo v3.5.59 platform-scale-milestone: 2026-04-14
- Oh My Codex multi-cycle brief: 2026-04-13
- Superset desktop-v1.4.7: 2026-04-13
- AG2 v0.11.5: 2026-04-13
- LangGraph 1.1.6: 2026-04-13

### Active Dispatch
- Oh My OpenAgent v3.15.x delegate-task convergence — specialist task_1775520476533_z8fx3g in-flight (dispatched Run #14)

### Star Baselines (post-Run #15)
- oh-my-openagent: 49,290 (accelerating)
- oh-my-codex: 18,206 (accelerating, +752/day)
- crewai: 48,276 (approaching 50k)
- deer-flow: 59,107 (single-cycle spike watch — needs 2 more cycles to confirm trend)
- ruflo: 30,616
- vibe-kanban: 24,576
- superset: 8,914
- langgraph: 28,647
- openai-agents: 20,633
- emdash: 3,718
- mux-coder: 1,611
- google-adk: 18,797
- ag2: 4,373

### Strategic Signal: CrewAI Closing Task-Persistence Gap
CrewAI 1.14.0 (Apr 7) shipped runtime state checkpointing (SqliteProvider, CheckpointConfig) — previously a differentiator for Optimus. Optimus should sharpen its checkpoint/resume story in docs.

### Strategic Signal: "oh-my-X" Harness Pattern (persists)
Both oh-my-codex and oh-my-openagent use `.omx/` project directory, skills, named roles, and Claude Code compatibility — identical philosophy to Optimus `.optimus/`. Specialist analysis in-flight.

### AutoGen (MSFT) Monitoring Gap
microsoft/autogen API calls blocked by SAML org enforcement. Requires PAT with microsoft org SAML authorization for reliable monitoring.

