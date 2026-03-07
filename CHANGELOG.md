# Changelog

## [0.0.3] - 2026-03-07
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
