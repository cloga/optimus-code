---
name: release-process
description: 'Generic, config-driven release process for any project type. Covers version bumping, changelog, build, documentation, tagging, and publishing with auto-detection for npm, Python, and Rust projects.'
---

# Release Process Skill

## When to Use
When the user or PM requests a new version release for any project.

## Pre-Release Decision (PM responsibility)
Before starting the release process, PM must evaluate:
1. Is there a release readiness report? Read it first.
2. P0 bug fix unreleased? → Immediate patch release
3. Multiple features accumulated? → Batch into minor release
4. Major architecture changes? → Requires: updated docs, migration guide, full CHANGELOG, council review
5. Only docs/chore? → Do NOT release just for this

## Pre-Release Checklist
Before starting, verify ALL of the following:
1. All target PRs are merged to the main branch
2. `git status` is clean on the main branch (no uncommitted changes in source directories)
3. All tests pass (if applicable)
4. No open PRs that should be included in this release

## Config Loading

Read `.optimus/config/release-config.json` if it exists. All fields are optional — omitted fields fall back to auto-detection.

**Config schema:**

| Field | Type | Description |
|-------|------|-------------|
| `version_files` | `string[]` | Files containing the version to bump. Infer format from extension (.json → JSON, .toml → TOML, .yaml → YAML). |
| `build_command` | `string \| null` | Shell command to build the project. `null` = skip build. |
| `test_command` | `string \| null` | Shell command to run tests. `null` = skip tests. |
| `changelog_file` | `string` | Path to changelog file. Default: `"CHANGELOG.md"`. |
| `docs_to_update` | `string[]` | Documentation files to review/update during release. Default: `["README.md"]`. |
| `stage_patterns` | `string[]` | Paths/globs for `git add` during release commit. |
| `tag_prefix` | `string` | Prefix for git tags (e.g., `"v"` → `v1.0.0`). Default: `"v"`. |
| `publish_command` | `string \| null` | Post-tag publish command. `null` = git-tag-only release. |
| `pre_release_hooks` | `string[]` | Shell commands to run after build but before release commit. |
| `post_release_hooks` | `string[]` | Shell commands to run after tag & push. |

### Auto-Detection (when no config exists or fields are omitted)

If `release-config.json` is missing or a field is omitted, auto-detect the project type. First match wins:

1. **`package.json` exists** → npm project
   - `version_files`: `["package.json"]`
   - `build_command`: `"npm run build"` (if `scripts.build` exists in package.json, else `null`)
   - `test_command`: `"npm test"` (if `scripts.test` exists in package.json, else `null`)
   - `stage_patterns`: `["package.json", "CHANGELOG.md"]` + `"dist/"` if build_command is set
   - `publish_command`: `null`

2. **`pyproject.toml` exists** → Python project
   - `version_files`: `["pyproject.toml"]`
   - `build_command`: `"python -m build"` (if build-system configured, else `null`)
   - `test_command`: `"pytest"` (if pytest in dependencies, else `null`)
   - `stage_patterns`: `["pyproject.toml", "CHANGELOG.md"]`
   - `publish_command`: `null`

3. **`Cargo.toml` exists** → Rust project
   - `version_files`: `["Cargo.toml"]`
   - `build_command`: `"cargo build --release"`
   - `test_command`: `"cargo test"`
   - `stage_patterns`: `["Cargo.toml", "Cargo.lock", "CHANGELOG.md"]`

4. **Nothing detected** → Generic fallback
   - `version_files`: `[]` (ask the user which files contain the version)
   - `build_command`: `null`
   - `stage_patterns`: `["CHANGELOG.md"]`

Config values always override auto-detection. Omitted config fields still fall back to auto-detected defaults.

## Release Steps (Execute in Order)

### Step 1: Determine Version
- Read `version_files` from release-config.json. If not configured, auto-detect from workspace.
- Read the current version from each version file.
- All version files MUST contain the same version. If they differ, halt and ask the user.
- Determine new version based on changes since the last tag:
  - Breaking changes → major bump
  - New features → minor bump
  - Bug fixes only → patch bump

### Step 2: Generate Changelog
- Read `changelog_file` from release-config.json. If not configured, default to `CHANGELOG.md`.
- Run `git log --oneline <last-tag>..HEAD` to list all commits since the last release.
- Categorize commits into: Features, Fixes, Improvements, Removed.
- Prepend a new version section to the changelog file with today's date.

### Step 3: Bump Versions
- Update the version string in every file listed in `version_files`.
- Infer the file format from the extension:
  - `.json` → update the `"version"` field in JSON
  - `.toml` → update the `version` key in TOML
  - `.yaml` / `.yml` → update the `version` key in YAML
  - Other → search and replace the old version string
- All version files MUST end up with the same new version.

### Step 4: Build
- Read `build_command` from release-config.json. If not configured, auto-detect from workspace.
- If a build command is configured or detected, execute it and verify it succeeds.
- If `null` or not detected, skip this step.

### Step 5: Run Pre-Release Hooks
- Read `pre_release_hooks` from release-config.json.
- Execute each hook command in order. If any hook fails, halt the release.

### Step 6: Documentation Check
- Read `docs_to_update` from release-config.json. If not configured, default to `["README.md"]`.
- Verify each listed document mentions new features/changes where appropriate.
- Verify the changelog file has the new version entry.

### Step 7: Commit Release
- Read `stage_patterns` from release-config.json. If not configured, auto-derive from version_files, changelog_file, and build output.
- Stage all matching files: `git add <stage_patterns>`
- Commit with message: `chore(release): v<VERSION>`

### Step 8: Tag & Push
- Read `tag_prefix` from release-config.json. If not configured, default to `"v"`.
- Create tag: `git tag <tag_prefix><VERSION>`
- Push to remote: `git push origin <branch> --tags`

### Step 9: Publish
- Read `publish_command` from release-config.json.
- If configured, execute it (e.g., `npm publish`, `cargo publish`).
- If `null` or not configured, skip — this is a git-tag-only release.

### Step 10: Verify
- Confirm tag exists on remote: `git ls-remote --tags origin | grep <tag_prefix><VERSION>`
- Confirm version in version files matches the new version.

### Step 11: Run Post-Release Hooks
- Read `post_release_hooks` from release-config.json.
- Execute each hook command in order.

## Post-Release
- Close any related "release" tracking issues.
- Notify in output_path with release summary.
