---
name: auto-release
description: 'Autonomous release gate: runs on a schedule, inspects commits since the last tag, determines whether to release, and executes the release pipeline via the release-process skill.'
version: 1.0.0
---

# Auto-Release Skill

## When to Use

This skill is invoked automatically by the `release-gate` cron job. Do not call it manually unless you are explicitly asked to trigger an immediate release.

## Required Skills

- `release-process` — performs the actual version bump, changelog, build, tag, and push

## Phase 1: Load Config

Read `.optimus/config/release-policy.json`. If the file is missing, use the defaults below.

**Config schema:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Must be `true` to proceed. Opt-in safety gate. |
| `max_auto_bump` | `"patch" \| "minor" \| "major"` | `"minor"` | Maximum semver bump level allowed autonomously. If commits indicate a higher bump, halt and request human input. |
| `cooldown_minutes` | `number` | `30` | Minimum minutes since last commit before releasing. Prevents releasing mid-session. |
| `extra_gates` | `string[]` | `[]` | Optional extra shell commands to run as quality gates (e.g., `"npm audit --audit-level=high"`). |

If `enabled` is not `true`, log "auto-release disabled" and exit immediately.

## Phase 2: Check Cooldown

1. Run `git log -1 --format=%ct` to get the UNIX timestamp of the most recent commit.
2. Compare against current time. If less than `cooldown_minutes` × 60 seconds have elapsed, exit with: "Cooldown active — last commit was N minutes ago."

## Phase 3: Inspect Unreleased Commits

1. Run `git describe --tags --abbrev=0` to get the last release tag.
2. Run `git log <last-tag>..HEAD --oneline` to list commits since the last release.
3. If the output is empty, exit with: "No unreleased commits — nothing to release."
4. **Infinite loop guard**: If ALL commits since the last tag match `^chore\(release\)` or `^release:`, exit with: "All pending commits are release commits — skipping to avoid loop."
5. Parse commit messages using **Conventional Commits** to determine bump level:
   - `feat:` or `feat(*)` → minor
   - `fix:`, `perf:`, `refactor:`, `docs:`, `chore:` → patch
   - `BREAKING CHANGE:` or `!` suffix → major
   - Any unrecognized format → patch (conservative default)
6. Take the **maximum** bump level across all commits. Cap at `max_auto_bump`.
7. If the required bump exceeds `max_auto_bump`, call `request_human_input` with:
   - The commit list
   - Why it exceeds the cap
   - Options: "Proceed as minor", "Skip this release cycle", "Override to major"
   - Do NOT proceed until a human responds.

## Phase 4: Run Extra Gates (if configured)

For each command in `extra_gates`:
1. Run the command.
2. If it exits non-zero, halt and log the failure. Do NOT release.

## Phase 5: Run Test Suite (MANDATORY gate)

Run `npm test` from the project root.

- If tests pass (exit code 0), proceed to Phase 6.
- If tests fail (non-zero exit), halt immediately. Log the test output.
  Do NOT proceed to release. Do NOT tag. Do NOT push.
  Use `request_human_input` to report the failure with test output summary.

## Phase 6: Execute Release

Delegate to `release-process` skill with:
- The determined bump level
- The commit list as context for changelog generation
- All standard release-process steps (build, changelog, tag, push)

If `release-process` fails at any step, log the failure and exit without tagging or pushing.

## Phase 7: Post-Release Verification

1. Run `git ls-remote --tags origin | grep v<newVersion>` to confirm the tag exists on remote.
2. Log the release summary: version bumped from X to Y, N commits included, tag pushed.

## Phase 8: Update Session State

Append to `.optimus/memory/release-history.md` (create if missing):

```
## <ISO timestamp> — v<newVersion>
- Bump: <patch|minor|major> (capped from <original> to <capped>)
- Commits: <count>
- Gate results: <pass/skip>
```

This provides audit trail across cron cycles.

## Constraints

- Never force-push, never rebase shared branches.
- Never modify application source code — only changelog, version files, and the release commit.
- On any ambiguity, call `request_human_input` rather than guessing.
