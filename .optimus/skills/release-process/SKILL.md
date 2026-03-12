---
name: release-process
description: 'Standard operating procedure for releasing a new version of the Optimus project. Covers version bumping, changelog, build, documentation verification, cleanup, tagging, and pushing.'
version: 1.0.0
---

# Release Process Skill

## When to Use
When the user or PM requests a new version release.

## Pre-Release Checklist
Before starting, verify ALL of the following:
1. All target PRs are merged to master
2. `git status` is clean on master branch (no uncommitted changes in src/)
3. All tests pass (if applicable)
4. No open PRs that should be included in this release

## Release Steps (Execute in Order)

### Step 1: Determine Version
- Read current version from `package.json` (root) and `optimus-plugin/package.json`
- Determine new version based on changes:
  - Breaking changes → major bump
  - New features → minor bump
  - Bug fixes only → patch bump

### Step 2: Generate Changelog
- Run `git log --oneline <last-tag>..HEAD` to list all commits since last release
- Categorize commits into: Features, Fixes, Improvements, Removed
- Prepend a new version section to `CHANGELOG.md` with date

### Step 3: Bump Versions
- Update `version` in `package.json` (root)
- Update `version` in `optimus-plugin/package.json`
- Both MUST match

### Step 4: Build
- Run `cd optimus-plugin && npm run build`
- Verify build succeeds and dist files are generated

### Step 5: Documentation Check
- Verify README.md mentions all new features/commands
- Verify system-instructions.md is up to date
- Verify CHANGELOG.md has the new version entry

### Step 6: Clean Up
- Ensure no stale feature branches remain: `git branch --merged master`
- Delete any merged local branches
- Ensure master is up to date: `git pull origin master`

### Step 7: Commit Release
- Stage: `git add package.json optimus-plugin/package.json CHANGELOG.md optimus-plugin/dist/`
- Commit: `git commit -m "chore(release): v<VERSION>"`
- Do NOT include .optimus/ runtime files in the commit

### Step 8: Tag & Push
- `git tag v<VERSION>`
- `git push origin master --tags`

### Step 9: Verify
- Confirm tag exists on remote: `git ls-remote --tags origin | grep v<VERSION>`
- Confirm version matches: `node -e "console.log(require('./package.json').version)"`

## Post-Release
- Close any "release" GitHub Issues
- Notify in output_path with release summary
