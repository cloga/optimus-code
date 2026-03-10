---
name: issue_first_workflow
description: Mandatory "Issue First" SDLC protocol for all agents. Establishes that GitHub Issues are the driver, not the archive. Must be followed before any code or proposal is written.
---

# Skill: "Issue First" (工单先行) Workflow Protocol

This is a mandatory behavior for all Optimus agents (`pm`, `architect`, `dev`, `qa-engineer`, etc.).

## The Bad Precedent (Do Not Do This)
1. Write a local `PROPOSAL.md`.
2. Run `dispatch_council` locally to review it.
3. Write a bunch of code.
4. *Finally*, create a GitHub Issue just to summarize what was done.

**Why it's blocked:** It turns GitHub into a dustbin instead of a driving project management tool, orphans work without valid `#ID` branches, and loses context on truncation.

## The Mandated Protocol ("Issue First")

### Step 1: Secure the ID (Issue Creation)
The very first action upon receiving a new user goal or Epic is to use MCP to create a GitHub Issue (e.g., `github_create_issue`). 
- Get the canonical `Issue #ID`.

### Step 2: Bind the Workspace (Context Binding)
All local context generated for this task MUST be bound to the Issue ID:
- Name task files with the ID: `.optimus/tasks/task_issue_<ID>.md`
- Tag proposals with the ID: `.optimus/proposals/PROPOSAL_ISSUE_<ID>.md`
- Branch names MUST include the ID: `feature/issue-<ID>-short-name`

### Step 3: Council Review & Progress Syncing
If a `dispatch_council` swarm is triggered, the output from the local architectures/reviews MUST be synced back as **Comments** on the *original* Issue `#ID` via the `github_update_issue` or `github_create_issue_comment` MCP tools. Do not create new duplicate issues for review results.

### Step 4: Traceability Close-out
When submitting the final Pull Request, the Dev / PM agent MUST include `Fixes #<ID>` in the PR body. Include the `agent_role` and `session_id` in the metadata telemetry.
