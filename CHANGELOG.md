# Changelog

## [0.0.5] - 2026-03-08
- **Repo Cleanup**: Removed debug log files, temp test scripts, and `temp_debug/` directory from root.
- **Gitignore Fix**: Replaced garbled `.gitignore` entries with clean rules; added patterns for `*.log`, `[LOG]`, `temp/`, `temp_debug/`.

## [0.0.4] - 2026-03-08
- **Modes-aware Agent Selection**: Agents now declare `modes: string[]`. Planning agent checkboxes show only agents with `"plan"` mode; executor dropdown shows only agents with `"agent"` mode.
- **Council → Executor Two-Phase Pipeline**: Phase 1 runs all selected planners concurrently; Phase 2 feeds synthesized plans to a single designated executor in `agent` mode.
- **Multi-turn Shared Task State**: `SharedTaskStateManager` tracks task history, open questions, blocked reasons, and auto-compacts context when token usage exceeds threshold.
- **Active Editor Context Injection**: The visible code range (or selection) from the active editor is automatically prepended to every planner prompt.
- **Streaming Callbacks Debounced**: Per-agent streaming updates are debounced at 100 ms to reduce webview re-render churn.
- **Image Paste Support**: Users can paste images into the prompt bar; images are saved to global storage and their paths are injected into the prompt.
- **Apply Code Block**: Executor output code blocks can be applied directly to workspace files via a one-click button.
- **Task Resume / Rename / Delete / Pin**: Full task lifecycle management from the history panel.
- **Debug Mode**: Optional `optimusCode.debugMode` setting surfaces per-adapter command, cwd, pid, and token usage in the UI.
- **Code Quality Fixes**: Replaced inline ANSI regex with shared `ANSI_RE` utility; extracted `_buildDebugObject` helper to eliminate duplicate debug-info construction; fixed `ReturnType<...>[0]` type annotations to use `AgentAdapter`; removed TOCTOU race in image storage; capped history view at 20 turns; added random suffix to image filenames to prevent collisions.

## [0.0.3] - 2026-03-07
- **Architecture Direction Clarified**: Documented the long-term move toward app-level multi-turn shared task state, including structured planner contributions, resumable task history, and executor context synthesis owned by the orchestrator layer.
- **UI Evolution**: Abandoned the vertical chat layout in favor of a Side-by-Side "Kanban Card" approach, allowing multiple models to dynamically run horizontally without drowning out the conversation. Added rich-text Markdown formatting using `marked`.
- **Architectural Shift - Dynamic Configuration**: Removed hardcoded Agent registries. The extension now deeply integrates with VS Code `workspace.getConfiguration`, enabling users to swap Models (`gpt-5.4`, `claude-opus-4.6`, etc.) on the fly without a reload.
- **Session History Persistence**: Added a "History" toggle to the chat sidebar. Conversations and agent responses are now persisted in `context.globalState` across VS Code sessions. Users can pull up previous architectural discussions instantly.
- **Architectural Shift - Streaming Execution**: Completely refactored the underlying OS execution layer from synchronous `cp.exec` to asynchronous continuous streams via `cp.spawn`. This immediately pumps stdout/stderr token-by-token directly to Webview.
- **Removed Hard Timeouts**: Set `timeout: 0` for all CLI tool executions, giving advanced Coding Agents the infinite runtime needed to utilize their own terminal-based "tools/skills" before formulating an output.
- **Structural Standardization**: Refactored project directory structure, moving extension components into `src/providers/` and standardizing the architecture according to project documentation.
- **Dependency Cleanup**: Removed `DoubaoAdapter` place-holder to keep the underlying structure clean but natively backwards compatible to ANY future adapter type string inputs.

## [0.0.2] - 2026-03-07
- Implemented asynchronous streamed UX updates. Instead of blocking the UI until all models finish, the chat interface now renders a dedicated task list indicating which agents are "Thinking" (🔄), completed (✅), or failed (❌).

## [0.0.1] - 2026-03-07
- Initial MVP creation.
- Shifted architecture from command-palette invocation to a persistent **Sidebar Webview Chat**.
- Implemented **Adapter Design Pattern** in `src/adapters/`.
