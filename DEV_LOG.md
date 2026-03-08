# Development Log & Decision Records

This document captures the context, rationale, and meaningful discussions (the "Why") behind technical decisions and architectural shifts in Optimus Code.

## [2026-03-08] - Enrich Planner Prompt Context for Better Planning Quality

### Context
Planning agents were running with a lightweight context that only included the task summary and last 2 executor outcome summaries. They had no visibility into open questions, blocked reasons, or what the user actually asked in previous turns. This caused planners to sometimes suggest approaches that had already failed, or to miss important unresolved questions.

### Root Cause
The original `buildPlannerPrompt()` design was intentionally minimal to avoid "groupthink" bias and keep planners lightweight. However, it was too minimal — planners lacked the situational awareness needed for multi-turn tasks.

### Changes Made
1. **Added `openQuestions`** (last 3) to planner context — planners now know what's unresolved.
2. **Added `blockedReasons`** (last 3) to planner context — planners now know what failed.
3. **Included user prompt in recent turn history** — changed from `Turn N: <outcome>` to `Turn N: User: <prompt> / Outcome: <outcome>`, so planners understand the conversation flow.
4. **Increased history window from 2 to 3 turns** — aligned with executor to reduce information gaps.
5. **Conditional sections** — `openQuestions` and `blockedReasons` only appear when non-empty, keeping first-turn prompts clean.

### Design Decision
Planner context is enriched but stays lighter than the executor's. Planners don't receive Task ID, the planner synthesis section, or the full executor instruction block. This preserves the "independent advisor" role while giving them enough situational awareness to plan effectively.

## [2026-03-08] - Structured Tool Trace Separation and Execution Timeline Rendering

### Context
Executor runs, especially through Claude structured streaming, were showing tool usage poorly. The UI often displayed raw tool traces as a dense markdown block, and in some cases the mixed streaming text polluted the final Output section.

### Root Cause
1. `PersistentAgentAdapter` treated the mixed structured streaming buffer as the preferred final result, even when the CLI had already emitted a cleaner `result` payload.
2. Tool-use events and assistant text deltas were merged into one linear string, so the frontend had no stable way to render execution steps independently from the final answer.
3. The Webview rendered `thinkingHtml` as a plain markdown block, which was acceptable for prose reasoning but poor for repeated tool-call traces.

### Changes Made
1. Split structured streaming into two channels inside `PersistentAgentAdapter`:
  - `structuredProcessText` for tool-use steps
  - `structuredAssistantText` / `structuredResultText` for assistant output
2. Added structured tool-call formatting so process entries are emitted as concise lines such as `• Read (file_path=...)`.
3. Changed final-output selection to prefer the clean `result` payload over the mixed streaming buffer, while still preserving the process trace for the Execution Process section.
4. Extended streaming UI updates to send raw `thinkingText` alongside rendered markdown.
5. Reworked Webview Execution Process rendering into a step timeline with numbered tool calls and separate log styling, while keeping markdown fallback behavior for non-tool reasoning.

### Why
- The Output panel must represent the agent's final answer, not an accidental concatenation of partial tool events.
- Tool traces are operational metadata and should read like a call timeline rather than a code block dump.
- Keeping process and answer separate also makes restored history sessions more trustworthy because the same structure can be replayed deterministically.

### Follow-up Refinement
The first pass still rendered tool arguments as a single flat string. This was improved further by:
1. expanding structured input summaries to include more path and line-oriented keys,
2. formatting tool calls as a title line plus `↳` detail lines, and
3. rendering those details as badge groups in the Webview.

This keeps executor traces compact while making file paths, line ranges, and command/query context immediately scannable.

### Second Follow-up Refinement
Real CLI event inspection showed that both adapters expose stable completion events:
- Claude emits `user.tool_result` payloads tied to the original `tool_use_id`
- Copilot emits `tool.execution_complete` events with structured `result.content`

Based on that, the process renderer was upgraded again to:
1. register tool-call ids during structured start events,
2. attach completion summaries back onto the same tool step,
3. render per-step status (`running`, `success`, `error`), and
4. surface result summaries as a separate completed section instead of burying them in the final answer.

This makes the Execution Process panel materially closer to a real agent tool-call trace rather than a best-effort transcript.

### Third Follow-up Refinement
There were still two conceptual mismatches after the trace work:
1. executor cards were identified by display-name suffixes like `(Executing)` / `(Executor)` while planner cards were not, and
2. Claude and Copilot still used separate adapter-local `extractThinking()` logic.

These were unified by:
1. adding explicit `role` metadata (`planner` / `executor`) to stored session responses,
2. rendering the same role badge style for both planners and executors instead of mutating the agent name,
3. removing executor-specific name suffixes from live and restored cards, and
4. introducing a shared base parsing helper in `PersistentAgentAdapter` so Claude and Copilot now use the same process/output extraction algorithm with only small regex-level differences.

The result is that planner and executor cards now differ by phase context, not by ad-hoc rendering rules, and Copilot/Claude traces now pass through the same normalization layer.

### Fourth Follow-up Refinement
The next consistency pass removed the remaining hardcoded divergence in the phase header layer and improved tool completion summaries:
1. phase start / done labels are now derived from a shared `phaseKind` model rather than being manually repeated as planner-only or executor-only strings,
2. restored history sessions use the same phase presentation helper as live runs,
3. the stale `extractProcessSteps` reference in the final-card renderer was removed in favor of the current normalized process-entry parser, and
4. tool completion summaries now use typed heuristics for common tools such as `Bash`, `Read`, `view`, `Glob`, and `Grep` instead of one generic fallback string.

This means the UI now differs between planner and executor only where it should: phase semantics. The visual structure, status model, and tool summary style are shared.

### Fifth Follow-up Refinement
The remaining mismatch was in the diagnostic/debug surface and the visual density of process badges:
1. `agentDebug` messages now carry `role` so planner and executor diagnostics can be rendered through the same phase-aware card layout,
2. the Webview debug panel now shows a structured grid instead of a raw newline dump, and
3. process badges are now typed visually (`path`, `count`, `preview`, `neutral`) so file paths, counts, and result previews are easier to distinguish at a glance.

This tightens the product-level consistency further: the tool trace, the phase header, and the debug panel now all follow the same planner/executor unification direction.

### Sixth Follow-up Refinement
The next pass focused on reducing visual noise while improving the usefulness of completed tool summaries:
1. runtime diagnostics are now rendered as a shared `Runtime Details` disclosure card in both the live debug strip and the final Input Prompt section, so the metadata stays available without competing with the main execution trace,
2. the old inline debug `pre` block was removed in favor of that same structured card renderer, and
3. tool completion summaries for high-frequency tools (`Read`, `Edit`, `Grep`, `Bash`, list/glob-style tools) now emit more structured parts such as `path=...`, `lines=...`, `matches=...`, `exit=...`, and `preview=...`.

This keeps the planner/executor cards quieter by default while making the completed-state badges materially more informative.

### Seventh Follow-up Refinement
Planner-side permission failures revealed that CLI permission mode alone was not enough to keep planning agents behaviorally read-only. Even in plan mode, the models could still propose or attempt edit-style tools before the runtime rejected them.

To fix that at the root prompt layer, `buildPlannerPrompt()` now explicitly states that planners are read-only, must not call edit/write/apply/create/delete tools, and must hand implementation steps off to the executor instead of narrating failed permission workarounds.

This aligns behavioral intent with the existing runtime restrictions: the planner plans, the executor executes.

### Eighth Follow-up Refinement
History had two data-loss problems and one UX problem:
1. user image attachments were saved to disk for the live turn but were never stored with the session record, so restored history only showed the text prompt,
2. agent output was only persisted as a final batch at turn completion, so interrupted or still-running agents could disappear from history, and
3. the history list / restore flow had no loading feedback, which made slower loads look broken.

This was fixed by storing image attachments in `StoredSession`, allowing the webview to resolve those files from the extension global storage directory, incrementally upserting running agent snapshots during streaming, and adding explicit loading cards for history list and restore operations.

## [2026-03-08] - Code Quality Hardening (Multi-Agent Review)

### Context
A council of three planner agents (Gemini 3.0 Pro, Opus 4.6, GPT-5.4) performed an independent parallel audit of the entire codebase. The executor synthesized their findings and applied the highest-priority fixes.

### Changes Made

1. **Dependency hygiene** — Removed orphaned `node-pty` from `dependencies` (never imported in `src/`). Added `iconv-lite` as an explicit dependency (was only available as a transitive dep from `node-pty`).

2. **Unified logging** — Replaced all 4 `console.log` and 2 `console.error` calls in production code with `debugLog()`. Affected files: `extension.ts`, `ChatViewProvider.ts`, `PersistentAgentAdapter.ts`, `configSync.ts`.

3. **Shared `ANSI_RE` constant** — Extracted the duplicated ANSI escape regex from `ClaudeCodeAdapter.ts` and `GitHubCopilotAdapter.ts` into `src/utils/textParsing.ts`.

4. **Type-safe session storage** — Defined `StoredSession` interface in `SharedTaskContext.ts`. Replaced all 6 occurrences of `any[]` session access in `ChatViewProvider.ts` with `StoredSession[]`, and typed the response mapper callback from `(r: any)` to `(r: SessionResponseRecord)`.

5. **Path traversal defense** — Added `path.posix.normalize()` + relative-path validation in `_applyCodeBlock()` to reject paths like `../../etc/passwd` before they reach `vscode.Uri.joinPath`.

6. **Output buffer safety cap** — Added a 10 MB `MAX_OUTPUT_BUFFER_BYTES` limit to `PersistentAgentAdapter.handleOutput()`. When exceeded, the oldest 20% of the buffer is discarded with a debug log warning.

### Not Addressed (Future Work)
- `ChatViewProvider.ts` remains >1600 lines — splitting into `CouncilOrchestrator` / `SessionManager` is a non-trivial refactoring.
- Token estimation heuristic still uses char-counting (accurate tokenizer deferred).
- Zero test coverage — test framework setup is a separate task.
- `err: any` in catch blocks — requires careful error type design.
- Race condition in `_runningTaskIds` check — needs atomic lock primitive.

## [2026-03-07] - Streaming Architecture, UI Pivot, and Dynamic Configurations

### 1. Migrating to Real-Time Streaming (`spawn` over `exec`)
- **Context**: Initially, `claude` and `@github/copilot` CLIs were executed using `child_process.exec`.
- **Problem**: Users noticed CLI tools hitting timeouts. Agents utilizing system tools or performing complex reasoning steps exceeded standard execution buffer limits and timeouts. Furthermore, the UI would hang until execution was entirely complete.
- **Decision**: Refactored the execution engine to use `child_process.spawn` with `timeout: 0` (infinite timeout).
- **Why**: `spawn` allows us to capture `stdout` and `stderr` streams in real time. By passing these streams through an `onUpdate` callback in the `AgentAdapter` interface, we achieve real-time markdown progressive rendering. Infinite timeouts allow autonomous agents to operate without arbitrary OS-level constraints.

### 2. Flexible Agent Configurations (`package.json` & Settings API)
- **Context**: Agent models were originally hardcoded in the adapter layer.
- **Problem**: Adding new models or changing the preferred underlying model required manual source code changes.
- **Decision**: Exposed an `optimusCode.agents` array in `package.json` configuration. Replaced static adapter initialization with dynamic reading from `vscode.workspace.getConfiguration('optimusCode')`.
- **Why**: New models can be integrated or toggled through VS Code settings without altering extension logic.

### 3. Kanban-Style UI (Horizontal Layout)
- **Context**: The original chat UI rendered agent outputs sequentially in a vertical list.
- **Problem**: Comparing responses or tool usage from multiple agents through vertical scrolling was hard.
- **Decision**: Refactored `ChatViewProvider.ts` to use a Flexbox-based side-by-side Kanban layout.
- **Why**: A horizontal comparison view aligns with the orchestration goal and makes multi-agent comparison easier.

### 4. Windows Command Execution and Newlines
- **Context**: Multiline prompts were passed to `claude` or `copilot` CLI on Windows.
- **Problem**: Raw newlines broke `cmd.exe` execution streams and interactive CLIs could hang waiting for standard input.
- **Decision**: Implemented prompt sanitization with `replace(/\r?\n/g, ' ')` and explicitly called `child.stdin.end()` after spawning.
- **Why**: Ensures safe CLI parameter passing and prevents blocking on EOF.

### 5. Standardized Project Directory Structure
- **Context**: The `src` directory was becoming cluttered with providers, components, and entrypoints at the same level.
- **Problem**: The flat structure made the codebase harder to navigate and maintain.
- **Decision**: Split architectural concerns into folders such as `src/providers/` and `src/adapters/`.
- **Why**: Improves separation of concerns and keeps the extension scalable.

### 6. Session History State Management
- **Context**: Users needed to revisit past prompts and multi-agent replies.
- **Problem**: In-memory Webview content disappeared after reload.
- **Decision**: Stored `optimusSessions` in `context.globalState` and built a History view to restore cached outputs.
- **Why**: Enables persistent multi-session workflows across IDE restarts.

### 7. Native Extension Handoff Investigation
- **Context**: Explored whether Optimus Code session history could be injected into native agent extensions.
- **Problem**: Native extensions manage their own sandboxed internal state and expose no public API for direct history mutation.
- **Decision**: Direct injection was deemed infeasible and too fragile.
- **Proposed Workaround**: A future handoff feature could write context to a temporary markdown file such as `.optimus/handoff.md` and invoke a native command referencing that file.
- **Why**: The filesystem is the only reliable shared protocol across isolated extensions.

### 8. Dynamic Agent Selection and Configuration UI
- **Context**: Users wanted to specify roles or system prompts per agent and selectively include agents per conversation.
- **Problem**: Doing this through settings alone was cumbersome.
- **Decision**:
  1. Expanded the `package.json` schema to support richer model configuration.
  2. Updated adapters to recognize injected role information.
  3. Reworked Webview initialization so the host sends `updateAgentSelector` into the Webview.
  4. Added dynamic checkboxes and a settings shortcut button in the chat input area.
- **Why**: Makes agent composition configurable without leaving the main UI.

### 9. Publishing and Distributing
- **Context**: The MVP was ready to be packaged and distributed.
- **Problem**: Manifest metadata was incomplete and `.vscodeignore` was missing.
- **Decision**: Added publisher, icon, and repository metadata, and created a standard `.vscodeignore`.
- **Why**: Prepares the extension for Marketplace distribution and manual VSIX installation.

- Added an MIT License to resolve `vsce` packaging warnings.
- Published MVP `v0.0.1` to the VS Code Marketplace under publisher `Trinity-Alpha`.
- Created a local `.env` for VSCE PAT storage and excluded it from git and VSIX packaging.
- Standardized build artifacts so `.vsix` files are emitted into `releases/` instead of the repo root.
- Fixed an issue where child processes spawned by adapters used the Extension Host directory instead of the active workspace directory.
- Added GitHub Actions publishing and bumped to `v0.0.2` for the first automated release.

### 10. Expanding UI and Resolving TTY Constraints
- **Context**: The `v0.0.3` interface needed more room. Horizontal scrolling worked, but CSS Flexbox `min-height` issues cut off vertical scrolling, and Session History lived as a small dropdown in a constrained sidebar.
- **Decision**:
  1. Fixed the Flexbox quirk using `min-height: 0` and constrained `chat-history` so horizontal and vertical scrolling coexist.
  2. Redesigned Session History into its own full-screen view using `.view.active` switching.
- **Why**: Multi-agent output needs a layout that remains readable under heavy information density.

### 11. Persistent Daemon Mode for Multi-turn Support
- **Context**: Agents were originally executed in single-shot mode such as `claude -p "prompt"` to bypass TTY limitations.
- **Decision**: Redesigned toward a persistent daemon model where the orchestrator spawns a backend session per agent and tracks end-of-turn markers.
- **Why**: Allows true multi-turn memory across turns instead of treating agents as stateless endpoints.

### 12. Frontend UI Mode Selection (Plan / Agent / Ask)
- **Context**: The user requested standard agent modes similar to Copilot.
- **Decision**: Added a mode dropdown in `ChatViewProvider` and passed the mode through `AgentAdapter.invoke()`. The backend respawned processes with mode-specific CLI arguments when necessary.
- **Why**: Keeps frontend intent aligned with backend permission models.

### 13. Dictator-for-Execution Protection
- **Context**: Allowing multiple autonomous agents to execute concurrently in Agent mode risks race conditions and file corruption.
- **Decision**: Added a defensive routing rule so only one agent executes in Agent mode and the user is warned when multiple agents are selected.
- **Why**: Preserves safe planning breadth without allowing concurrent writes.

### 14. Explicit Executor Agent Configuration
- **Context**: Picking the first selected agent during Agent mode was unpredictable.
- **Decision**: Added explicit executor-agent control, later evolving into UI-based executor selection instead of hidden settings.
- **Why**: Makes execution control explicit and consistent with the core orchestration model.

## [2026-03-07] - UI Crashing and Code Cleanliness Constraints
- **Bug**: Nested and heavily indented template literals inside `ChatViewProvider.ts` caused malformed compiled output and froze the Webview UI.
- **Fix**: Restored the file from git history and rewrote dynamic HTML generation with strict string concatenation instead of nested backtick templating.
- **Guardrails Implemented**: Updated `copilot-instructions.md` with workspace cleanliness rules so generated debugging scripts and logs must be deleted immediately or confined to `scripts/` or `temp/`.
- **Tidying Up**: Moved older `test-*.js`, `daemon*.txt`, and `build_log.txt` out of the root directory and into `scripts/`.

## [2026-03-07] - Webview Initialization Race Condition
- **Context**: After fixing inline script syntax, the sidebar no longer rendered blank, but the agent selector still stayed empty and core actions silently failed on first load.
- **Problem**: The Webview posted its initial message during startup, but the extension host registered `onDidReceiveMessage` only after assigning `webview.html`.
- **Decision**: Registered the message handler before assigning the HTML and added an explicit `webviewReady` handshake.
- **Why**: Removes timing-sensitive startup behavior and makes initial agent loading deterministic.

## [2026-03-07] - Agent Selector Reliability Hardening
- **Context**: Even after adding `webviewReady`, the agent row could still appear empty.
- **Problem**: The frontend originally sent `webviewReady` before its own `window.message` listener was attached, and the selector depended on `vscode-checkbox`.
- **Decision**: Moved the ready message to the end of the script and replaced selector rendering with native HTML checkbox inputs wrapped in styled labels.
- **Why**: Native inputs reduce toolkit coupling and the reordered handshake guarantees a live listener before the first payload arrives.

## [2026-03-07] - Complete Eradication of Nested Template Literals in Webview Script
- **Context**: The UI shell rendered, but agent checkboxes never appeared and all message handlers were dead.
- **Root Cause**: Escaped template literals inside an outer template literal compiled into invalid JavaScript inside the inline `<script>` block.
- **Verification**: Extracted the compiled `<script>` and confirmed the syntax failure with `node -c`.
- **Decision**: Replaced every nested template literal in the Webview message handlers with plain string concatenation.
- **Result**: The extracted script passes `node -c` with zero errors.
- **Lesson**: Never emit escaped backtick template literals inside TypeScript template literals that will become inline script content.

## [2026-03-07] - Executor Agent UI Dropdown and Removing Settings-based `executorAgent`
- **Context**: The `optimusCode.executorAgent` setting required users to know agent IDs and edit settings JSON.
- **Problem**: This was not discoverable and forced users to leave the extension UI.
- **Decision**: Removed the `optimusCode.executorAgent` configuration property from `package.json` and added an `executor-selector` dropdown in the Webview UI. The selected executor ID is sent with each `askCouncil` message and used by `_delegateToCouncil`.
- **Why**: Keeps executor selection inside the UI while preserving the planning and execution split.

## [2026-03-07] - Non-Interactive Execution for Plan/Ask/Auto Modes
- **Context**: All modes previously used the persistent interactive daemon approach.
- **Problem**: Prompt-detection strings did not reliably match actual CLI output, causing the UI to hang at deliberation state.
- **Decision**: Refactored `PersistentAgentAdapter.invoke()` to use a dual strategy. Non-agent modes use one-shot `-p` execution, while `agent` mode retains persistent multi-turn behavior.
- **Why**: One-shot mode is deterministic because the process exits naturally without prompt matching.

## [2026-03-07] - Agent Modes Configuration (`modes` Field)
- **Context**: Users wanted to control which agents are available for planning versus execution.
- **Problem**: Previously all configured agents appeared in all modes, including the executor dropdown.
- **Decision**: Added a `modes` field to the agent configuration schema, adapter interfaces, and adapter factory. The executor dropdown now only shows agents whose `modes` include `agent`.
- **Configuration applied**:
  - `Copilot (Gemini 3.0 Pro)`: `["plan", "ask", "auto"]`
  - `Copilot (GPT-5.4)`: `["plan", "ask", "auto"]`
  - `Claude Code (Opus 4.6 1M)`: `["plan", "ask", "auto", "agent"]`
  - `Claude Code (GPT-5.4)`: `["plan", "ask", "auto", "agent"]`
- **Why**: Enforces capability boundaries at configuration level.

## [2026-03-07] - Max 3 Agent Selection Limit
- **Context**: With 4 or more agents configured, running all of them concurrently for every query is wasteful and slow.
- **Decision**: The Webview checkbox logic now enforces a maximum of 3 simultaneously selected agents. The first 3 are checked by default.
- **Why**: Balances breadth of perspective against response latency and cost.

## [2026-03-07] - Auto Mode: Two-Phase Council to Executor Pipeline
- **Context**: The user clarified that Auto mode should use plan agents for analysis, then feed their results to a designated executor agent for action.
- **Decision**: Removed the mode selector entirely. The extension now operates in Auto mode only: selected agents run in `plan`, then successful plan outputs are synthesized into one executor prompt and dispatched to the chosen executor in `agent` mode.
- **Why**: This is the cleanest expression of the "多谋独断" principle: many planners, one executor.

## [2026-03-07] - Server-side Initial Render for Agent Controls
- **Context**: The Webview repeatedly regressed into a state where the agent pills and executor options were empty even though the HTML shell itself rendered.
- **Problem**: The initial UI depended on the inline script completing the `webviewReady` to `updateAgentSelector` handshake.
- **Decision**: `ChatViewProvider._getHtmlForWebview()` now pre-renders the initial agent checkbox pills and executor options on the extension-host side using `getActiveAdapters()`.
- **Why**: Removes the startup handshake as a single point of failure for basic usability.

## [2026-03-07] - Delegated Button Event Handling in Webview
- **Context**: After the control row became visible again, action buttons such as `Send`, `Compact`, `Stop`, `History`, `Settings`, and `Debug` still intermittently had no effect.
- **Problem**: Directly binding click listeners to `vscode-button` elements is fragile because those controls are custom elements registered asynchronously by the toolkit.
- **Decision**: Replaced direct per-element listeners with a delegated `document.addEventListener('click', ...)` handler using `event.composedPath()` to identify clicked controls by ID.
- **Why**: Event delegation is resilient to custom-element upgrade timing and DOM regeneration.

## [2026-03-07] - Dual-path Button Binding for Webview Controls
- **Context**: Pure delegated handling still left `Send` and `History` unresponsive in the live Webview.
- **Problem**: Relying on a single propagation path was too brittle. Some interactions were lost between the custom element host, its internal clickable node, and the document-level listener.
- **Decision**: Added a shared `handleButtonAction()` dispatcher and bound each control twice: directly on the host element with `click` and `pointerup`, and again through capture-phase document listeners as fallback.
- **Why**: Trades elegance for reliability so the Webview remains operable even if toolkit internals change.

## [2026-03-07] - Native Prompt Input and Removing Enter-to-Send
- **Context**: The prompt input remained unreliable, and the user explicitly did not want pressing Enter to send a message.
- **Problem**: `vscode-text-area` adds another custom-element lifecycle dependency inside an already fragile Webview. That made input behavior harder to trust and also conflicted with the expected multiline authoring flow.
- **Decision**: Replaced `vscode-text-area` with a native `textarea` styled to match the existing UI and removed the `keydown` handler that submitted on Enter.
- **Why**: Native textareas are predictable in Webviews, support multiline input by default, and align with the intended interaction model where only the `Send` button submits a message.

## [2026-03-07] - Prompt Shortcut Switched to Enter Send / Shift+Enter Newline
- **Context**: After the native textarea stabilization, the user chose to restore keyboard submission because chat input felt unnecessarily slow when it required a mouse click on every turn.
- **Decision**: Added a dedicated prompt keyboard binding in the extracted Webview script so `Enter` submits the message, while `Shift+Enter` preserves multiline authoring.
- **Why**: This keeps the predictable native textarea behavior while matching mainstream chat ergonomics and preserving an intentional newline path.

## [2026-03-07] - In-page Webview Diagnostics for Interaction Failures
- **Context**: The remaining blocker was not visual rendering but dead interaction. Buttons and input appeared, yet the user still experienced no response from core controls.
- **Problem**: Browser devtools are inconvenient for this loop, and prior guesses could not distinguish whether failure occurred in the frontend event layer, during `postMessage`, or inside the extension-host message handler.
- **Decision**: Added a persistent diagnostics panel directly inside the Webview. It records script boot, captured clicks, direct button handlers, outbound `postMessage` calls, host acknowledgements, inbound host messages, and uncaught frontend errors.
- **Why**: This turns the UI into its own trace surface. We can now localize failures immediately to one of three layers: frontend events, Webview-to-host messaging, or host-side handling.

## [2026-03-07] - Codified VS Code Debugging Practice in Project Instructions
- **Context**: Repeated Webview regressions showed that ad-hoc debugging was too expensive and too easy to repeat inconsistently across sessions.
- **Decision**: Added a dedicated `Debugging Practice` section to `.github/copilot-instructions.md` covering the standard three-layer debugging model: `Extension Host`, `Webview frontend`, and `Webview <-> Host messaging`, plus the required troubleshooting order and when to prefer native controls or extracted scripts.
- **Why**: This converts recent debugging lessons into an explicit project rule so future work follows a stable diagnostic workflow instead of making speculative UI changes first.

## [2026-03-07] - Runtime-only Webview Parse Failures from Encoding and Escaping
- **Context**: Even after TypeScript compiled cleanly and earlier extracted-script checks appeared to pass, the Webview still failed before any button handling or diagnostics could run.
- **Root Cause 1**: Non-ASCII icon characters embedded in inline HTML and JavaScript strings were corrupted at runtime into malformed tokens, breaking browser parsing inside the Webview.
- **Root Cause 2**: Some inline-script strings used `\n` inside the outer TypeScript HTML template in a way that rendered as literal line breaks inside JavaScript string literals, which is invalid syntax in the browser-facing script.
- **Decision**: Replaced Webview-facing icon glyphs with ASCII-safe labels and changed debug-string newlines to escaped `\\n` so the rendered script remains syntactically valid after HTML generation.
- **Why**: This fixes the real browser-facing artifact rather than only the source file. The correct validation target for inline Webview scripts is the fully rendered HTML/JS, not just TypeScript compilation.

## [2026-03-07] - Debug Mode Moved from UI Button to Configuration
- **Context**: Once the Webview was interactive again, the diagnostics surface became useful, but controlling it with a transient `Debug` button made state unclear and added another clickable control into an already fragile UI.
- **Decision**: Added a formal `optimusCode.debugMode` configuration property, removed the `Debug` button from the Webview toolbar, and changed the host to push debug state into the Webview through an `updateUiState` message. The workspace setting in `.vscode/settings.json` now enables debug mode for this repo by default.
- **Why**: Debug visibility is now deterministic and source-controlled. The configuration becomes the single source of truth for diagnostics, and the UI no longer needs its own separate toggle state.

## [2026-03-07] - Webview Script Extracted to External Resource
- **Context**: Repeated Webview failures were consistently tied to inline script generation inside `ChatViewProvider.ts`, especially around escaping, encoding, and browser-facing syntax drift that TypeScript alone did not reveal.
- **Decision**: Moved the Webview frontend logic out of the inline `<script>` block and into `resources/chatView.js`. `ChatViewProvider.ts` now renders only the HTML shell, initial server-side content, and a `<script src="...">` reference to the external resource.
- **Why**: This makes the frontend debuggable as a normal JavaScript file, eliminates template-string parsing risk for most UI logic, and aligns the project with the documented VS Code Webview debugging practice.

## [2026-03-07] - OutputChannel-based Host Debugging for Agent Execution
- **Context**: Once Webview interaction and script parsing were stabilized, the remaining unknowns shifted to the extension-host side, especially Claude CLI invocation, stdout/stderr behavior, and executor routing.
- **Decision**: Added a dedicated `Optimus Code Debug` output channel and instrumented the extension activation path, Webview message handling, council delegation, and `PersistentAgentAdapter` process lifecycle. The host now logs mode, cwd, full command, prompt length, stdout chunks, stderr chunks, process errors, exit codes, and daemon stdin writes when `optimusCode.debugMode` is enabled.
- **Why**: This brings the project in line with standard VS Code extension debugging practice. The host side can now be inspected through the Output panel instead of relying only on Webview diagnostics or ad-hoc breakpoints.

## [2026-03-07] - Windows Long Prompt Execution Without `cmd /c`
- **Context**: Executor prompts can become much longer than planner prompts because they include shared task summary, recent turn state, blockers, and planner synthesis.
- **Problem**: On Windows, non-interactive invocations were routed through `cmd /c` so npm-installed CLIs such as `claude.cmd` and `copilot.cmd` could be resolved. That shell hop reduced the practical maximum command length enough to trigger `> [LOG] 命令行太长。` before the target CLI even started.
- **Decision**: Added wrapper resolution in `PersistentAgentAdapter` so Windows `.cmd` launchers are translated to direct `node <entry-script>` execution when possible.
- **Why**: Spawning the real Node entrypoint bypasses the `cmd.exe` length ceiling while preserving argument boundaries and existing streaming behavior.

## [2026-03-07] - Oversized Prompt Fallback via Runtime Briefing Files
- **Context**: Bypassing `cmd /c` raises the ceiling, but synthesized executor prompts can still exceed safe process-argument sizes on Windows when task history and planner contributions grow.
- **Decision**: Added a second-stage fallback for non-interactive invocations: if the prompt exceeds a threshold, the adapter writes the full prompt into `.optimus/runtime-prompts/*.md` inside the workspace and passes only a short wrapper prompt that instructs the agent to read that file first.
- **Why**: This removes prompt size from the command-line transport path while keeping the briefing inside the allowed workspace boundary and preserving current adapter APIs.
- **Follow-up**: Exposed the threshold as `optimusCode.promptFileThresholdChars` and expanded debug snapshots so the UI and OutputChannel show whether a run used `inline` or `file` prompt transport.

## [2026-03-07] - Agent Capability Matrix Simplified to `plan` and `agent`
- **Context**: The orchestrator workflow is now fixed as council planners followed by one executor. The previous `ask` and `auto` entries inside per-agent `modes` no longer matched how the UI actually selects participants.
- **Decision**: Reduced agent capability configuration to `plan` and `agent` only. Default capabilities are now:
- `github-copilot-gemini`, `github-copilot-gpt5`, `github-copilot-opus`: `plan`
- `claude-code-opus`: `plan`, `agent`
- `claude-code-gpt5`: `agent`
- **Why**: This matches the real product model and avoids misleading selections where an agent looked selectable but could never appear in the planner or executor slots users expected.

## [2026-03-08] - Planner Card DOM Collisions and Executor Usage Logs
- **Context**: Planner execution results showed all three Copilot planners in the synthesized executor prompt, but the planning UI sometimes rendered only two cards. Separately, the executor card could finish without a `Usage Log` section even though the planner cards had one.
- **Root Cause 1**: Frontend planner cards used DOM ids derived only from sanitized agent names. Across repeated councils, those ids were not council-scoped, so later stream updates could target the wrong node and visually hide one planner card.
- **Root Cause 2**: `ClaudeCodeAdapter` only enabled structured output parsing for `plan` mode. The executor currently runs Claude in one-shot `agent` mode, so usage metadata was never extracted for that path.
- **Decision**: Scoped planner DOM ids by council instance and enabled Claude structured output parsing for both `plan` and `agent` modes.
- **Why**: This keeps all selected planners visible and makes executor cards render the same `Usage Log` section when Claude returns usage metadata.

## [2026-03-07] - Windows Claude Planner Prompt and Workspace Fallback Hardening
- **Context**: Host-side debug logs showed that Webview messaging and council delegation were correct, but Claude planner runs still returned the generic greeting `Hello. How can I help with your code?` instead of responding to the user prompt.
- **Root Cause 1**: Non-interactive planner calls passed raw multiline prompt text into `-p`, which is fragile on Windows shell execution paths and can degrade into behavior that looks like a normal interactive session bootstrap.
- **Root Cause 2**: When no workspace folder was resolved, the adapter fell back to `process.cwd()`, which in the extension host pointed at the VS Code installation directory rather than the actual project being discussed.
- **Decision**: Hardened `PersistentAgentAdapter` in two ways: sanitize non-interactive prompts into a single safe line before passing them to `-p`, and prefer a workspace path hint or active editor directory before ever falling back to `process.cwd()`.
- **Why**: Claude and Copilot both need deterministic prompt and cwd semantics on Windows. Fixing the adapter boundary is more reliable than compensating later inside provider orchestration or UI code.
- **Follow-up Debugging Enhancement**: Added `cwdSource` to process-start logs so each Claude/Copilot run now states whether its working directory came from `workspaceFolder`, `activeEditor`, `workspacePathHint`, or `process.cwd()`.
- **Webview-time Fallback**: Also register the workspace hint again from `ChatViewProvider.resolveWebviewView()`, because some Extension Host sessions activate before VS Code exposes a usable workspace folder. This makes the later Webview lifecycle a second chance to bind the real repo path before any planner or executor process is launched.
- **Debugging Environment Fix**: Updated `.vscode/launch.json` so the Extension Development Host opens the current workspace folder instead of an empty window, and added a development-only fallback to `extensionUri.fsPath` when no workspace can be resolved yet. This prevents local extension debugging from accidentally targeting the VS Code installation directory.

## [2026-03-07] - Explicit Turn Completion Marker for Persistent Agent Mode
- **Context**: After fixing cwd resolution, Claude one-shot `plan` execution succeeded from the correct repo path, but the remaining hang risk was still concentrated in persistent `agent` mode.
- **Problem**: The daemon path considered a turn finished only when stdout contained the adapter's prompt string such as `>`. That is brittle because CLI prompt rendering can vary by model, permissions mode, terminal environment, or future CLI updates.
- **Decision**: Each persistent turn now appends an explicit completion instruction with a unique marker like `[[OPTIMUS_DONE_...]]`. The adapter resolves the turn when that marker appears and strips it from streamed/final output before rendering.
- **Why**: Turn completion is now governed by an application-level protocol we control rather than by reverse-engineering the CLI's prompt rendering behavior.

## [2026-03-07] - Explicit stdin Close for Non-interactive CLI Invocations
- **Context**: Even after cwd was corrected, some one-shot `claude -p ...` runs inside the extension host still appeared to stall right after process start, despite the same command exiting normally in a manual terminal test.
- **Decision**: Non-interactive invocations now explicitly call `child.stdin.end()` immediately after spawn and emit a debug warning if the process is still alive after 15 seconds.
- **Why**: Some CLI wrappers continue waiting on stdin/EOF even when a prompt was already provided through `-p`. Closing stdin makes the one-shot contract explicit and gives debugging a clear signal when the process still does not exit.
- **State Cleanup Follow-up**: One-shot invocations now also clear `this.childProcess` on `error` and `close`, so a finished planner process is not misinterpreted as an active daemon when the executor phase begins.

## [2026-03-07] - Claude Executor Switched from Daemon to One-shot Agent Invocation
- **Context**: After fixing cwd and one-shot stdin closure, Claude planner calls completed correctly, but the executor still hung before any daemon stdout/stderr appeared.
- **Root Cause**: Manual terminal validation showed that `claude -p ... --dangerously-skip-permissions` completes successfully, while the non-TTY persistent daemon path produced no observable turn output in the extension host.
- **Decision**: Added an adapter-level policy hook for persistent sessions and configured `ClaudeCodeAdapter` to use one-shot execution even for `agent` mode. This preserves the `--dangerously-skip-permissions` execution semantics without depending on an interactive daemon shell.
- **Why**: For the current Auto pipeline, Claude executor work is a single synthesized task, not a multi-turn conversation. A deterministic process exit is a better completion signal than trying to emulate an interactive terminal protocol inside the extension host.

## [2026-03-07] - App-level Multi-turn Shared State Plan Formalized
- **Context**: After stabilizing planner execution and switching Claude executor away from the fragile non-TTY daemon path, the remaining design question became how to support meaningful multi-turn work and cross-agent awareness without reintroducing CLI-session brittleness.
- **Decision**: Formally chose **app-level multi-turn** as the target architecture. Shared task memory will live in the orchestrator layer rather than inside individual CLI sessions. The project documentation now defines a future `SharedTaskStateManager`, structured planner/executor contribution records, resumable task snapshots, and bounded context compression.
- **Why**: This model is more natural for Optimus Code's product goal. It allows all agents to see the same task facts, prior actions, blockers, and outcomes instead of each agent remembering only its own private conversation.
- **Documentation Impact**: Updated `IDEA_AND_ARCHITECTURE.md` and `README.md` so future implementation work has an explicit architectural baseline rather than relying on ad-hoc discussion history.

## [2026-03-07] - Shared Task State Phase 1 Implemented
- **Context**: After formalizing the app-level multi-turn direction, the next step was to move from documentation into a minimal but real runtime foundation without rewriting the whole UI or adapter surface.
- **Decision**: Added `src/types/SharedTaskContext.ts` and `src/managers/SharedTaskStateManager.ts`, then integrated `ChatViewProvider` so each council run now creates or continues a task, opens a turn record, captures planner contributions plus executor outcomes, synthesizes executor context from task state, and persists the updated task snapshot.
- **Why**: This establishes the core host-side data model for shared memory while keeping adapters thin and preserving the current Auto-only workflow. Future resume UI and context compression can now build on real persisted task state instead of only session transcripts.
- **Current Scope Boundary**: The Webview still behaves mostly the same and history remains session-oriented for now, but each saved session now carries `taskId` / `turnId`, giving later work a stable bridge from read-only history into resumable tasks.

## [2026-03-07] - Shared Task State Phase 2: Task Visibility and Context Compression
- **Context**: Once task/turn records existed in host state, the next risks were invisibility and unbounded prompt growth. Without UI exposure, users could not tell whether a turn was continuing an existing task. Without prompt compression, executor context would eventually balloon across many turns.
- **Decision**: Added a lightweight task-state strip to the Webview showing current task title, status, turn count, and latest summary. Session history entries are now enriched with task snapshot metadata. On the host side, `SharedTaskStateManager.buildExecutorPrompt()` now applies deterministic compression to prior turn summaries, open questions, blockers, and planner synthesis.
- **Why**: Multi-turn state must be inspectable and bounded. Visible task identity makes continuation behavior understandable, and deterministic compression keeps executor prompts stable before introducing more advanced summarization.

## [2026-03-07] - Shared Task State Phase 3: Explicit Resume Task Semantics
- **Context**: After wiring shared task state into history, the remaining UX ambiguity was that viewing a historical session also implicitly changed the current task. That made it hard to distinguish "inspect an old result" from "continue this task from here".
- **Decision**: Split history interaction into two explicit actions: `View` restores a snapshot for inspection only, while `Resume` switches the current task and reloads the corresponding session/task context for future turns. Host-side debug logging now also includes `taskId` and `sessionId` on relevant Webview and adapter debug paths.
- **Why**: App-level multi-turn only stays understandable if task continuation is explicit. Users need a clear boundary between reading historical output and mutating the active shared task state.

## [2026-03-07] - Shared Task State Phase 4: Rich Current Task Visibility
- **Context**: After adding explicit resume semantics, the task strip still only showed a coarse summary. That was enough to prove state existed, but not enough to explain what the latest turn actually did.
- **Decision**: Expanded the Webview task strip to show the latest turn sequence and status, the most recent planner set, the latest executor summary, and recent open questions / blockers. The host now includes these fields in `updateTaskState` messages.
- **Why**: Shared task state is only useful if the user can inspect it quickly while working. Surfacing the current turn and unresolved items makes multi-turn continuation legible without opening raw persisted state.

## [2026-03-07] - Added CLAUDE.md Aligned With Repository Agent Rules
- **Context**: The repository already had `.github/copilot-instructions.md`, but Claude Code also needs an explicit project-local instruction file so both agents follow the same workflow constraints and architecture assumptions.
- **Decision**: Added `.claude/CLAUDE.md` that mirrors the active project rules in Claude-friendly form: Chinese communication, English code/documentation, immediate decision logging, zero-error verification, layered VS Code extension debugging, workspace cleanliness, and the current Auto-only shared-state architecture direction.
- **Why**: This keeps Copilot and Claude Code aligned on the same operating model and reduces drift between tools when both are used on the same repository.

## [2026-03-07] - Ignored Agent-specific Metadata Directories
- **Context**: The repository now contains both `.claude/` and `.github/` agent instruction assets. The user requested that both directories be treated as local metadata rather than tracked project files.
- **Decision**: Added `.claude/` and `.github/` to `.gitignore`.
- **Why**: This prevents agent-specific local configuration from being included in future commits and keeps repository tracking focused on product code and project docs.

## [2026-03-07] - Active Editor Context Injection and Live Context Badge
- **Context**: Planners received no automatic code context from the current editor, forcing users to manually copy-paste relevant snippets into the prompt.
- **Decision**: Added `_getActiveEditorContext()` to `ChatViewProvider`: it reads the current selection (priority) or the visible range (fallback, capped at 80 lines), wraps it in an `<active-editor-context>` block, and prepends it to the enriched planner prompt. The original user prompt without context is still what gets stored in task state. A `_sendContextBadge()` helper posts live updates to the Webview whenever the active editor or selection changes, rendering a small pill above the textarea so users always know what context will be injected.
- **Why**: Planners now have automatic, bounded code awareness without requiring users to change their workflow. The 80-line cap and selection-priority strategy keeps the injected context useful without bloating planner prompts on large files.
- **Phase 4 item completed**: "Read `vscode.window.activeTextEditor` to inject live context automatically."

## [2026-03-07] - WorkspaceEdit Apply-to-File for Executor Code Blocks
- **Context**: Executor agents (e.g. Claude) often produce fenced code blocks with a target filename in the info string. Previously users had to manually copy these blocks and apply them to the right file.
- **Decision**:
  1. `ChatViewProvider` now handles an `applyCodeBlock` message from the Webview. It uses `vscode.WorkspaceEdit` to replace the full content of an existing file, or create a new file, then opens the result in the editor. On success it posts a `codeBlockApplied` confirmation back to the Webview.
  2. `chatView.js` receives the executor `rawText` alongside `htmlContent` in the `agentDone` message. `extractCodeBlocks()` parses fenced blocks that carry a filename in the info string (e.g. ` ```typescript src/foo/bar.ts `). `injectApplyButtons()` inserts a styled "Apply to \<file\>" button above each matching `<pre>` in the rendered output.
  3. After host confirms apply, matching buttons update to "Applied ✓" and disable.
- **Convention**: Executor fenced blocks must include a relative file path in the language line for the button to appear. This matches the natural output style of Claude Code and GitHub Copilot.
- **Why**: Closes the loop from "executor plans changes" to "changes land in the workspace" without leaving the UI. Keeps the adapter layer unmodified — the Apply interaction is purely between the Webview and the ChatViewProvider.
- **Phase 4 item completed**: "Inject code block replacements back into the workspace utilizing `WorkspaceEdit`."
- **All Phase 4 items now complete.** Phase roadmap updated to ✅.

## [2026-03-07] - Planner Multi-turn Context Injection via buildPlannerPrompt
- **Context**: Planners were stateless — each turn they received only the current editor context and user prompt with no awareness of prior work. The design doc (§2.3) stated planners and the executor should see the same shared task facts, but the implementation had not fulfilled this for planners.
- **Problem**: In multi-turn sessions, planners would re-analyze from scratch every turn, potentially producing redundant plans or plans that ignored already-completed steps.
- **Decision**: Added `buildPlannerPrompt` to `SharedTaskStateManager`. It prepends a `<task-context>` block containing:
  - Task title
  - Current turn sequence number
  - `latestSummary` (compressed task-level summary, ≤280 chars)
  - Last 2 executor outcome summaries (≤200 chars each)
  Then appends the original `enrichedPrompt` (editor context + user input) unchanged.
- **Why lightweight vs executor**: Planners should form independent opinions without being anchored to prior planner outputs or open questions. Giving them only "what has been done" (executor outcomes) lets them plan the next step without recycling prior planner biases. The executor, which synthesizes and acts, needs the full picture including blockers, open questions, and all planner contributions.
- **Design boundary maintained**: Adapters receive a single prompt string. No adapter-level changes were needed.
- **`IDEA_AND_ARCHITECTURE.md` updated** to reflect the two-tier prompt strategy (lightweight planner context vs full executor context).


### UI Redesign: Tool-Call Style Agent Outputs
- **Problem**: The multi-agent visual blocks ('Council Verdict' columns) and the bulky 'Task State Strip' consumed too much vertical space and disrupted the chat flow.
- **Change**: Radically simplified the chat UI. 
  - Represented Planners and Executors as vertically stacked <details> blocks, mirroring the mental model of 'Tool Calls' hidden inside a standard chat interface.
  - Squashed the Task State Strip into a single, compact sticky header showing just the task title and turn counts instead of echoing redundant state metadata.

### Alignment with Copilot/Claude UX
- **Decision**: Made the \Planner\ phase automatically collapse upon success. This keeps the final \Executor\ output immediately visible at the bottom of the chat without forcing the user to scroll past large blocks of intermediate planning steps. This directly aligns with the native tool-calling mental models and UX patterns of GitHub Copilot and Claude Code.

### Centralized Context: The \.optimus/\ Directory
- **Decision**: Created the \.optimus/\ directory to hold system-wide configuration files like \.optimus/rules.md\. 
- **Implementation**: Added an auto-sync utility (\src/utils/configSync.ts\) runs upon extension activation. It reads \.optimus/rules.md\ and overwrites \.claude/CLAUDE.md\ and \.github/copilot-instructions.md\. 
- **Why**: Ensures all CLI-based agents adhere strictly to the exact same system prompts. This also lays the groundwork for future extensions like \	asks.md\ and \memory.md\ without cluttering the project root.
