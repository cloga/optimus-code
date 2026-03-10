---
name: standard_pr_workflow
description: Executing standard Git branch creation, Pull Request generation, and Agile Issue tracking workflow.
triggers:
  - "PR"
  - "pull request"
  - "commit"
  - "push code"
  - "close issue"
---

# Git Workflow & Pull Request Skill (Standard SDLC)

You are operating under the strict **"Issue First" Hybrid SDLC Protocol**. It is an architectural violation to implement code and merge it straight to `main` without creating a PR or updating the tracking Issue.

## The Standard Protocol

When asked to "commit the code", "create a PR", or handle "code changes", you MUST execute the following exact sequence:

### 1. Identify the Tracking Issue
Every code change must relate to a GitHub Issue (e.g., `#29`).
- If none exists, ask the user or check the local Blackboard (`.optimus/tasks/`).
- Do not proceed until you have an Issue Number.

### 2. Branch Check
Never commit directly to `main` for standard feature work unless explicitly overridden by the User (PM).
- Command: `git checkout -b feature/issue-<ID>-short-desc`
- Example: `git checkout -b feature/issue-29-arc-refactor`

### 3. Stage & Commit
Group logically related changes into an atomic commit.
- Use Conventional Commits.
- **Critical Requirement**: Append `, closes #<ID>` or `, fixes #<ID>` to the commit message to automate GitHub's state closure.
- Command: `git commit -m "feat: Implement T1/T2 instantiation, closes #29"`

### 4. Push Branch to Origin
Push the newly created branch to the remote repository.
- Command: `git push -u origin <branch-name>`

### 5. Create Pull Request (MUST use MCP Tool)
Create the PR and assign the corresponding tracking metadata.
- **You MUST use the MCP Tool `github_create_pr`** to create the Pull Request. **DO NOT** use `gh` CLI or manual terminal commands for this step. The system is configured with correct credentials internally.
- Use your registered MCP tool calls explicitly passing `owner`, `repo`, `title`, `head`, `base` (usually 'main'), and `body`.
- If the PR needs to be merged after checking, use the MCP Tool `github_merge_pr`.

### 6. Update Blackboard / T1 Memory
Once the PR is open, update the local Project Blackboard and/or the T1 Agent Memory `.optimus/agents/<your_role>.md` to record that the implementation is complete and pending review.

## Constraints & Error Handling
- **Missing Token / Auth Failures**: Operations like `gh pr create` might fail on locked enterprise terminals. If it fails, do not loop endlessly. Print the exact URL for the user to visit and stop.
- **Merge Conflicts**: If the branch cannot be pushed cleanly, stop and ask the Architect or Developer to rebase. Do not forcefully overwrite origin.
- **Dirty Tree**: Stash or advise the user to review untracked files before creating a new branch.