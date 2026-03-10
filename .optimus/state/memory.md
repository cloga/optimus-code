# Optimus Code - Project Memory

## Codebase Architecture Map

Core architecture: VS Code extension with "Council for Planning, Dictator for Execution" two-phase pipeline.

### Key Files & Responsibilities

| File | Responsibility |
|------|---------------|
| `src/extension.ts` | Extension entry point, activation, command registration |
| `src/providers/ChatViewProvider.ts` | Main orchestrator: UI ↔ host messaging, agent invocation, mode routing (auto/plan/direct), turn lifecycle |
| `src/managers/SharedTaskStateManager.ts` | Prompt building (planner/executor/direct), task state CRUD, memory/rules reading, context compaction |
| `src/managers/MemoryManager.ts` | File I/O for `.optimus/memory.md` (read/append/clear) |
| `src/adapters/PersistentAgentAdapter.ts` | Base adapter: CLI process spawning, streaming output, JSON parsing |
| `src/adapters/ClaudeCodeAdapter.ts` | Claude Code CLI adapter (extends PersistentAgentAdapter) |
| `src/adapters/GitHubCopilotAdapter.ts` | GitHub Copilot CLI adapter (extends PersistentAgentAdapter) |
| `src/types/SharedTaskContext.ts` | TypeScript interfaces: SharedTaskState, TurnRecord, ContributionRecord, etc. |
| `resources/chatView.js` | Webview frontend: chat UI, message rendering, user interactions |

### Data Flow

1. User prompt → `ChatViewProvider._runAgents()` (line ~500)
2. Mode routing: auto → planners + executor, plan → planners only, direct → executor only
3. Planner prompt built by `SharedTaskStateManager.buildPlannerPrompt()` (line 90)
4. Executor synthesis prompt built by `SharedTaskStateManager.buildExecutorPrompt()` (line 156)
5. Results stored in VS Code `globalState` under keys `'optimusTaskStates'` and `'optimusSessions'`

### Storage Locations

- Task state: VS Code globalState (`optimusTaskStates`), max 25 tasks
- Session history: VS Code globalState (`optimusSessions`), max 50 sessions
- Project memory: `.optimus/memory.md` (this file)
- Project rules: `.optimus/rules.md`
- CI/CD: `.github/workflows/publish.yml`

<!-- updated 2026-03-08 -->
该项目当前正确的扩展构建流程是 `npm run compile` -> `tsc --noEmit` + `node esbuild.js`，目标产物应为单文件 `out/extension.js`，不应保留旧的 `tsc` 分目录 JS 输出。
