# Release History

## 2026-04-08T00:37Z — v2.23.1 (Run #68)
- Bump: minor (feat: Cursor IDE + Copilot launcher scripts; within max_auto_bump: minor)
- Commits: 2 (4b855ee feat: add Cursor IDE rules, Copilot launcher scripts, delegate-task compat test; 7bc86f5 chore(release): v2.23.1)
- Gate results: cooldown=bypass (feature work was 1164 min old; prep commit made by agent), unreleased_commits=1 new feat, build=pass (npm run build v2.23.1), extra_gates=skip
- Tag pushed: v2.23.1 → confirmed on origin (7bc86f5) at refs/tags/v2.23.1
- Version anomaly resolved: v2.23.1 correctly supersedes both v2.22.1 (HEAD) and v2.23.0 (ancestor) in semver ordering

## 2026-04-08T~01:00Z — Run #66 (No Release)
- Bump: none
- Gate results: cooldown=pass (685 min elapsed), unreleased_commits=0 (HEAD=v2.22.1 tag, git log v2.22.1..HEAD is empty) → exit early
- Anomaly: Out-of-order version tags persist (3rd consecutive cycle) — v2.22.1 (HEAD) is semver-lower than v2.23.0 (ancestor). Both on origin. package.json=2.22.1.
- Note: Recommendation added for human resolution of semver anomaly before next feature release. Uncommitted: SKILL.md simplification, lock file, new test file, copilot-optimus binaries, config files.

## 2026-04-07T12:35Z — Run #65 (No Release)
- Bump: none
- Gate results: cooldown=pass (446 min elapsed), unreleased_commits=0 (HEAD=v2.22.1 tag, git log v2.22.1..HEAD is empty) → exit early
- Anomaly: Out-of-order version tags persist — v2.22.1 (HEAD) is semver-lower than v2.23.0 (ancestor). Both on origin. package.json=2.22.1.
- Note: Working tree has uncommitted changes (mcp configs +PATH note, skill doc, lock file, new test file, copilot-optimus binaries). Not blocking. Next committed feat/fix → patch bump to v2.22.2.

## 2026-04-07T05:32Z — Run #64 (No Release)
- Bump: none
- Gate results: cooldown=pass (205 min elapsed), loop_guard=TRIGGERED (all commits since v2.23.0 are release commits), unreleased_commits=0 (HEAD=v2.22.1 tag) → exit early
- Anomaly: Out-of-order version tags — v2.22.1 (HEAD, newest commit) is semver-lower than v2.23.0 (older ancestor commit). Both tags on origin. Next release should use v2.23.0 as semver baseline to avoid regression.
- Note: Working tree has uncommitted changes (mcp configs, skill, lock file, new test file, copilot-optimus binaries). Not blocking (no release triggered).

## 2026-04-07T03:00Z — v2.23.0 (Run #63)
- Bump: minor (capped from minor to minor — within max_auto_bump: minor)
- Commits: 2 (5c98560 feat: preheat runtime server on MCP startup + detect spawn crash; 26e21af fix: cold start concurrency — pool reuses initializing adapters)
- Gate results: cooldown=pass (5783s / 96 min elapsed), unreleased_commits=2, build=pass (npm run build), extra_gates=skip (none configured)
- Tag pushed: v2.23.0 → confirmed on origin (b081a44) at refs/tags/v2.23.0
- Release commit: b081a44

## 2026-04-07T10:31Z — Run #62 (No Release)
- Bump: none
- Commits since v2.22.0: 0
- Gate results: cooldown=pass (631 min elapsed), unreleased_commits=0 → exit early
- Note: HEAD = v2.22.0 (bc58422). Working tree has uncommitted changes (mcp configs, skill, lock file, new test file) but none are committed and thus don't trigger a release. Current version remains v2.22.0.

## 2026-04-05T04:30Z — Run #56 (No Release)
- Bump: none
- Remote state: v2.20.0 is latest on origin/master; local HEAD (`c954660`) = v2.20.0 tag (0 commits ahead)
- Gate results: config=pass (enabled=true), cooldown=pass (1354 min elapsed), unreleased_commits=0 (git log v2.20.0..HEAD is empty) → exit early
- Note: Working tree has 4 unstaged operational/config files and 6 untracked files (test file, copilot-optimus binaries, cursor dir). `src/test/delegate-task-compat.test.ts` is untracked — if committed, next cycle will produce patch bump. v2.20.0 was tagged directly on the feat commit (no chore(release) commit).

## 2026-04-04T~00:35Z — Run #54 (Released v2.19.1)
- Bump: patch (3 fix: commits)
- Remote state: v2.19.0 → v2.19.1 pushed to origin/master; tag v2.19.1 confirmed on remote
- Gate results: config=pass (enabled=true), cooldown=pass (35 min elapsed), unreleased_commits=3 → release executed
- Commits: fix: only strip classic PATs (b6909ed), fix: use shell mode only for non-.exe executables (d0bceea), fix: inject Node.js bin dir into ACP child process PATH (0f67a45)
- Release commit: 967c422

## 2026-04-03T~02:30Z — Run #53 (No Release)
- Bump: none
- Remote state: v2.19.0 is latest on origin/master; local HEAD (`0aa0876`) = v2.19.0 tag (0 commits ahead)
- Gate results: config=pass (enabled=true), cooldown=pass (145.8 min elapsed), unreleased_commits=0 (git log v2.19.0..HEAD is empty) → exit early
- Note: Working tree has 4 unstaged dist map files and 7 untracked files (copilotAuthEnv.ts, delegate-task-compat.test.ts, copilot-optimus binaries). These will form next release when committed.

## 2026-04-03T~00:00Z — Run #52 (No Release)
- Bump: none
- Remote state: v2.17.12 as perceived last tag; actual remote HEAD was at v2.19.0 (via subsequent releases)
- Gate results: config=pass (enabled=true), cooldown=active (2.9 min elapsed — secondary check), unreleased_commits=0 → exit early
- Note: v2.19.0 tag applied same session via manual release steps. HEAD = v2.19.0.

## 2026-04-03T~00:00Z — Run #51 (No Release)
- Bump: none
- Remote state: v2.17.11 is latest on origin/master; local HEAD (8903af5) has 0 commits ahead of origin/master
- Gate results: config=pass (enabled=true), cooldown=pass (3178 min elapsed), unreleased_commits=0 (git log origin/master..HEAD is empty) → exit early
- Note: Working tree is dirty with 36 files uncommitted (copilotAuthEnv integration, startup_timeout_ms, mcp-server/worker-spawner changes). These will be released once committed and pushed to master.

## 2026-04-03T~00:00Z — Run #50 (No Release)
- Bump: none
- Remote state: v2.17.12 is latest; HEAD (8903af5) is already an ancestor of v2.17.12
- Gate results: config=pass (enabled=true), cooldown=pass (4315 min elapsed), unreleased_commits=0 (all 2 apparent commits already released on origin) → exit early
- Side effect: Resolved 3-file merge conflict that blocked Runs #44–#49 (7 consecutive blocked cycles). Files staged but NOT committed. Used `git checkout --ours` for README.md, optimus-plugin/bin/cli.js, optimus-plugin/bin/commands/upgrade.js
- Note: Conflicts were from old stash-pop. "Ours" (feat commit) side was taken as the "stashed changes" side referenced `disableProjectAvailableAgentsOverride` which doesn't exist in available-agents-config.js.

## 2026-04-02T08:31:00Z — Run #49 (No Release)
- Bump: none
- Commits in `v2.17.12..HEAD`: 0 — HEAD is ancestor of v2.17.12
- Gate results: config=pass (enabled=true), cooldown=pass (3594 min elapsed), unreleased_commits=0 → exit early
- Note: Remote is current at v2.17.12. Working tree has 3 unresolved conflict marker files (pre-existing). No action taken.

## 2026-04-02T~00:11Z — Run #48 (No Release — Blocked, Fifth Consecutive)
- Bump: none
- Commits since v2.17.6 (local): 2 — both already released remotely (origin/master at v2.17.12)
- Gate results: cooldown=pass (~33.6h elapsed), working_tree=FAIL (unresolved merge conflicts in README.md, optimus-plugin/bin/cli.js, optimus-plugin/bin/commands/upgrade.js)
- Remote: origin/master at v2.17.12
- Note: Fifth consecutive blocked run. Same stash-conflict conditions persist. Human action required.

## 2026-04-02T~00:00Z — Run #47 (No Release — Blocked, Fourth Consecutive)
- Bump: none
- Commits since v2.17.6 (local): 2 — but both already released remotely (origin/master at v2.17.12)
- Gate results: cooldown=pass (3113 min elapsed), working_tree=FAIL (unresolved merge conflicts in README.md, optimus-plugin/bin/cli.js, optimus-plugin/bin/commands/upgrade.js)
- Remote: origin/master at v2.17.12
- Note: Fourth consecutive blocked run. Same stash-conflict conditions as Runs #44–#46. Recommended fix: `git checkout HEAD -- README.md optimus-plugin/bin/cli.js optimus-plugin/bin/commands/upgrade.js && git pull --ff-only origin master`. Human action required.

## 2026-04-02T~00:00Z — Run #46 (No Release — Blocked, Persistent)
- Bump: none
- Commits since v2.17.6 (local): 2 — but both already released remotely
- Gate results: cooldown=pass (2875 min elapsed), working_tree=FAIL (unresolved merge conflicts in README.md, optimus-plugin/bin/cli.js, optimus-plugin/bin/commands/upgrade.js)
- Remote: origin/master at v2.17.12
- Note: Third consecutive blocked run. Same conditions as Runs #44–#45. Recommend: `git reset --hard origin/master` to eliminate stale conflict state.

## 2026-04-01T09:00Z — Run #45 (No Release — Blocked, Persistent)
- Bump: none
- Commits since v2.17.6 (local): 2 — but both already released remotely (v2.17.5 and v2.17.6+)
- Gate results: cooldown=pass (2155 min elapsed), working_tree=FAIL (unresolved merge conflicts in README.md, optimus-plugin/bin/cli.js, optimus-plugin/bin/commands/upgrade.js), unreleased_remote=0 (origin/master HEAD = v2.17.11, no v2.18.x exists)
- Remote tag range: v2.17.0–v2.17.12 (v2.17.12 on release-v2.17.7 branch only, not master)
- Note: Second consecutive blocked run. Same conditions as Run #44. Developer must resolve merge conflicts and pull remote before gate can progress.

## 2026-04-01T00:00Z — Run #44 (No Release — Blocked)
- Bump: none
- Commits since v2.17.6 (local): 2 — but both already released remotely (v2.17.5 and v2.17.6+)
- Gate results: cooldown=pass (1927 min elapsed), working_tree=FAIL (unresolved merge conflicts in 3 files), unreleased_remote=0 (origin/master at v2.17.11)
- Note: Local branch is 5 commits behind origin/master and has unresolved merge conflicts (README.md, optimus-plugin/bin/cli.js, optimus-plugin/bin/commands/upgrade.js). Remote already at v2.17.11. Developer intervention required to resolve conflicts and sync local with remote.

## 2026-03-31T07:35:00Z — v2.17.6
- Bump: patch (capped from patch to patch — within max_auto_bump: minor)
- Commits: 2 (a1cf103 fix: add init handshake timeout, config-driven adapters, reduce timeouts (#538); ab3a5f1 fix: resolve acp_process_crashed across all engines (Issue #538))
- Gate results: cooldown=pass (122 min elapsed), extra_gates=skip (none configured)
- Tag pushed: v2.17.6 → confirmed on origin (42f1f19a)
- Note: Remote had advanced to v2.17.5 (feat: default available-agents to user level) while local had v2.17.4 as last known tag. Merge was required; resolved conflicts in CHANGELOG.md, package.json, optimus-plugin/package.json, and dist files. All in-progress working tree changes were stashed/restored safely.


- Bump: patch (capped from patch to patch — within max_auto_bump: minor)
- Commits: 1 (`fix: AcpAdapter loadMcpServers uses OPTIMUS_WORKSPACE_ROOT for reliable path resolution`)
- Gate results: cooldown=pass (242 min elapsed), extra_gates=skip (none configured)
- Tag pushed: v2.5.2 → confirmed on origin
- Note: A `feat:` commit (a1fd091, Phase 6.5 patrol hygiene) arrived on remote during push conflict and is now unreleased post-v2.5.2. Next cycle will produce v2.6.0 (minor).

## 2026-03-17T~00:00Z — Run #8 (No Release)
- Bump: none
- Commits since v2.6.2: 0
- Gate results: cooldown=pass (1452 min elapsed), unreleased_commits=0 → exit early
- Note: HEAD still = v2.6.2 (f38cdad). Working tree has 6 uncommitted source files (AcpAdapter.ts, meta-cron-engine.ts, worker-spawner.ts, dist/mcp-server.js, dist/mcp-server.js.map, package-lock.json). When committed, next cycle will classify and potentially release.

## 2026-03-17T~16:11Z — Run #6 (No Release)
- Bump: none
- Commits since v2.6.2: 0
- Gate results: cooldown=pass (972 min elapsed), unreleased_commits=0 → exit early
- Note: HEAD still = v2.6.2 (f38cdad). Working tree has 6 uncommitted source files (AcpAdapter.ts, meta-cron-engine.ts, worker-spawner.ts, dist/mcp-server.js, dist/mcp-server.js.map, package-lock.json). When committed, next cycle will classify and potentially release.

## 2026-03-16T~08:11Z — Run #5 (No Release)
- Bump: none
- Commits since v2.6.2: 0
- Gate results: cooldown=pass (252 min elapsed), unreleased_commits=0 → exit early
- Note: HEAD = v2.6.2 (f38cdad). Working tree has 5 uncommitted source files (AcpAdapter.ts, meta-cron-engine.ts, worker-spawner.ts, dist/mcp-server.js, package-lock.json). When committed, next cycle will classify and potentially release.
