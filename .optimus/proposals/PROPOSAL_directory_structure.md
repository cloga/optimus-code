# PROPOSAL: Clean up and Restructure the `.optimus/` Blackboard Directory

## Current State
The `.optimus/` directory acts as our local blackboard and artifact sandbox. However, it has become cluttered with loose files at its root level:
- Multiple `PROPOSAL_*.md` files (`PROPOSAL_github_blackboard.md`, `PROPOSAL_SCM_MCP.md`, `PROPOSAL_extension.md`, etc.)
- Stray JS scripts (`delegate.js`, `script-check.js`, `test-council.js`)
- Configuration and rule files (`rules.md`, `memory.md`, `protocol.md`, `TODO.md`)

Subdirectories currently tracking organized data:
- `personas/`
- `registry/`
- `reports/`
- `reviews/`
- `runtime-prompts/`
- `tasks/`

## User Request
The user pointed out: "Shouldn't these proposals be in a unified directory? Find some architects to look at the current directory architecture and see what can be optimized."

## Review Task
As expert architects, please review this structure and recommend:
1. A formalized taxonomy for the `.optimus/` folder (e.g., should proposals go into `.optimus/proposals/`?).
2. What to do with the stray JS scripts. Should they be moved to `.optimus/scripts/` or `temp_scripts/`?
3. Where should core rule sets (`rules.md`, `memory.md`, `protocol.md`) reside?
4. A concise, executable set of shell commands to implement your recommended refactoring so that the master agent can immediately execute it.