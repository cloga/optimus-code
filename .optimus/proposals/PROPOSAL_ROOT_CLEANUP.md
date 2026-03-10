# Proposal: Root Directory Cleanup (Rev. 2 - Post-Council Review)

## Background
The optmimus-code repository root is cluttered with numerous temporary, experimental, and test scripts (e.g., 	est*.js, ix*.js, dd*.js, 	mp*.js), multiple markdown planning docs, and logs. This breaks repository hygiene. 

Following a Council Review between the PM, Architect, and QA, the execution plan has been strictly unified.

## Execution Requirements (Gated Policies)

1. **.gitignore First Policy**:
   Before any files are moved, 	emp_scripts/ **MUST** be added to .gitignore. Moving tracked scripts prevents Git pollution.

2. **No Orphan References Guarantee**:
   Run an automated search (grep -r "require\|import" src/ --include="*.ts") to ensure no temp script is dynamically loaded by production code before moving.

## Action Plan

### Step 1: Secure the Destination
- Append /temp_scripts/ to .gitignore.

### Step 2: Relocate Scripts (to 	emp_scripts/)
Move the following explicit categories into 	emp_scripts/. If duplicate names exist (e.g. 	est_raw.js), append a suffix (e.g., 	est_raw_root.js).
- 	est*.js (	est_raw.js, 	est_syntax.js, 	est2.js - 	est8.js)
- Operations scripts (ix*.js, dd*.js, mod*.js, xtract.js, ewrite*.js)
- call_mcp.js (if exists)

### Step 3: Document Migration (to docs/)
Move all high-level planning artifacts that aren't critical README/CHANGELOG/LICENSE into the docs/ folder:
- IDEA_AND_ARCHITECTURE.md
- FINAL_OPTIMIZATION_PLAN.md
- REFACTOR_PLAN_SESSION_IPC.md
- DEV_LOG.md
- qa_report.md / qa_report2.md
- Any PROPOSAL_*.md files lying in the root.

### Step 4: Trash & Expiration (Action: DELETE)
Safely delete the following purely intermediate build/debug outputs and UI testing noise:
- 	mp_final.js, 	mp_final.html
- .txt logs: debug_diff.txt, delegation_result.txt, 	ask_summary.txt
- .log files: 2026-03-09_*.log

### Step 5: Retain the Build Core
- Leave intact: package.json, sbuild.js, 	sconfig.json, README.md, CHANGELOG.md, LICENSE.
