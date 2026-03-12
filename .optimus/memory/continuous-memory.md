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

