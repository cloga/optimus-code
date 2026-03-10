● Read optimus-code\.optimus\proposals\PROPOSAL_ROOT_CLEANUP.md
  └ 23 lines read

● Read optimus-code\.optimus\personas\qa-engineer.md
  └ 13 lines read

● List directory optimus-code
  └ 55 files found

● List directory optimus-code\temp_scripts
  └ 30 files found

● Read optimus-code\package.json
  └ 262 lines read

● Glob "**/*.js" in C:\Users\lochen\optimus-code\src
  └ No matches found

● Read optimus-code\.gitignore
  └ 20 lines read

● Read optimus-code\.vscodeignore
  └ 26 lines read

---

## QA Engineer Critique: PROPOSAL_ROOT_CLEANUP.md

**Role:** QA Engineer (T1 Local Expert)
**Session:** `6f10ac7d-8c68-4d34-ab2f-d8694b42d8cd`

---

### ✅ What the Proposal Gets Right

- Correctly identifies the root pollution problem (20+ stray `test*.js`, `fix*.js`, `tmp*.js` files).
- Preserves build-critical files (`esbuild.js`, `package.json`, `tsconfig.json`).
- Notes the need to check for active references before archiving. Good instinct — but unverified (see below).

---

### 🚨 Issues Found

#### 1. **Incomplete File Inventory (High Severity)**
The proposal silently ignores files currently in root that should be categorized:
- `qa_report.md`, `qa_report2.md` — not in the "retain" list or the "move" list.
- `2026-03-09_18-01-05-998-debug.log`, `2026-03-09_21-37-25-481-debug.log` — `.log` files at root; the proposal only addresses `.txt` outputs.
- `call_mcp.js` — not a `test*`/`fix*`/`add*` match but clearly a utility script; unaddressed.
- `temp_data/` directory — already exists, never mentioned.
- `test-council.js` — doesn't match `test*.js` glob (hyphen), may be skipped by naive automation.

**Risk:** A scripted cleanup will leave behind unlisted files, defeating the purpose.

---

#### 2. **Duplicate File Collision — `test_raw.js` (High Severity)**
`test_raw.js` already exists in **both** the root **and** `temp_scripts/`. Moving root's `test_raw.js` to `temp_scripts/` will silently overwrite or error. The proposal has no collision resolution strategy (rename, diff, or skip).

---

#### 3. **Ambiguous Destination Creates Future Clutter (Medium Severity)**
The proposal offers two destinations for test scripts: `temp_scripts/` **or** a "newly defined `.optimus/experimental/`" — with no decision criteria. This will result in ad-hoc placement and recreate the same organizational ambiguity in subdirectories within weeks.

---

#### 4. **`temp_scripts/` Not in `.gitignore` or `.vscodeignore` (Medium Severity)**
- `.gitignore` currently covers `temp/` and `temp_debug/` but **not** `temp_scripts/`. All those archived scripts will continue to be tracked by Git and committed.
- `.vscodeignore` similarly does not cover `temp_scripts/`. If VSIX packaging runs without this fix, the archived scripts will be **bundled into the published extension**, needlessly bloating every install.

---

#### 5. **No Dependency Audit Mechanism (Medium Severity)**
The proposal states: *"Make sure none of these scripts are being actively referenced by production scripts before archiving them"* — but provides zero tooling or process for this verification. A quick `grep -r "require.*fix_spawn\|fix_queue_ui\|add_queue2"` across `src/` is the bare minimum. Without this step the plan can break runtime behavior and the verification burden is left entirely to whoever executes it.

---

#### 6. **Planning/Design Docs Retained at Root Inconsistently (Low Severity)**
`FINAL_OPTIMIZATION_PLAN.md`, `REFACTOR_PLAN_SESSION_IPC.md`, `IDEA_AND_ARCHITECTURE.md` are retained at root, but a `docs/` directory already exists. These are prime candidates for `docs/`. The proposal preserves root clutter it could eliminate.

---

#### 7. **No Rollback Strategy (Low Severity)**
No mention of a git tag, branch, or stash before executing the moves. If a dynamically `require()`d script (e.g., via string interpolation) breaks after the move, there is no structured recovery path articulated.

---

### 📊 Summary Table

| Issue | Severity | Blocks Execution? |
|---|---|---|
| Incomplete file inventory | High | Yes |
| `test_raw.js` collision | High | Yes |
| Ambiguous destination | Medium | No |
| `temp_scripts/` missing from `.gitignore`/`.vscodeignore` | Medium | No |
| No dependency audit mechanism | Medium | Yes |
| Design docs not moved to `docs/` | Low | No |
| No rollback strategy | Low | No |

---

### 🏁 Recommendation: **HYBRID (Accept with Mandatory Pre-Conditions)**

The proposal's intent is sound and the root genuinely needs cleanup. However, **two blockers must be resolved before execution**:

1. **Complete the inventory** — account for every untracked file in root (`.log` files, `qa_report*.md`, `call_mcp.js`, `test-council.js`, `temp_data/`).
2. **Resolve the `test_raw.js` collision** explicitly (diff contents, keep or rename).

**Required alongside execution:**
- Add `temp_scripts/` to both `.gitignore` and `.vscodeignore`.
- Run a `grep`/`rg` dependency scan across `src/` for all script names before moving them.
- Pick a **single** destination for experimental scripts (recommend `temp_scripts/` for consistency with what already exists; drop the `.optimus/experimental/` option or define it for a distinct category).
- Create a git tag (e.g., `pre-cleanup`) before executing any moves.


> [LOG] 
Total usage est:        1 Premium request
API time spent:         1m 1s
Total session time:     1m 10s
Total code changes:     +0 -0
Breakdown by AI model:
 claude-sonnet-4.6       112.7k in, 2.8k out, 98.0k cached (Est. 1 Premium request)