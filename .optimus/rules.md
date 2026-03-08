# .optimus/rules.md (Single Source of Truth for Prompts)

This file provides system-wide project-specific instructions for all Agents (Claude, Copilot, etc.) working in this repository.

> **DO NOT EDIT `.claude/CLAUDE.md` OR `.github/copilot-instructions.md` DIRECTLY.**
> Edit this file instead. The Optimus extension will automatically synchronize these rules to the respective agent folders.

## GitHub Operations

- Target GitHub account: `https://github.com/cloga/`
- When creating repositories, configuring remotes, opening releases, or performing other GitHub operations, direct them to the `cloga` account to avoid EMU policy issues.

## Language Rules

- Communicate with the user in Chinese.
- Write all code, code comments, commit messages, variable names, and technical documentation in English.

## Documentation And Tracking

- After every significant discussion, implementation, or debugging step, evaluate whether `README.md`, `IDEA_AND_ARCHITECTURE.md`, `CHANGELOG.md`, or `DEV_LOG.md` should be updated.
- Capture the reasoning, tradeoffs, and architectural context immediately in `DEV_LOG.md` or `IDEA_AND_ARCHITECTURE.md`. Do not wait for a git commit before documenting the why.
- Prefer documenting architectural decisions while the context is still fresh.

## Code Quality And Reliability

- Maintain a zero-error standard for edited code.
- After code changes, verify the project still compiles successfully with `npx tsc --noEmit` or an equivalent project-specific validation command.
- Prefer fixing root causes over layering temporary workarounds.

## Debugging Practice

When debugging this VS Code extension, always work in layers and validate them in order.

### 1. Extension Host

- For provider logic, commands, adapters, activation flow, and `onDidReceiveMessage`, prefer `F5` with the Extension Development Host.
- Use TypeScript breakpoints and inspect the Debug Console before making speculative code changes.
- Prefer stable logging points or a dedicated `OutputChannel` over ad-hoc guesses.

### 2. Webview Frontend

- For DOM issues, dead buttons, rendering regressions, or script boot failures, use `Developer: Toggle Developer Tools` and inspect the specific Webview frame.
- Check for startup `SyntaxError`, `ReferenceError`, and broken event handlers before changing business logic.
- If `@vscode/webview-ui-toolkit` components behave inconsistently, temporarily switch to native HTML controls to isolate toolkit lifecycle issues from application logic.

### 3. Webview <-> Host Messaging

- For any interaction bug, verify all message-path stages explicitly:
  1. frontend event fired
  2. frontend `postMessage` sent
  3. host `onDidReceiveMessage` received it
  4. host `webview.postMessage` returned data
  5. frontend `window.message` received it
- Do not keep changing UI behavior until the failing layer is localized.

### Webview Script Safety

- Treat inline Webview scripts generated inside TypeScript template literals as high-risk.
- Nested template literals, escaped backticks, and non-ASCII text inside inline scripts are especially error-prone.
- If Webview logic becomes large or fragile, prefer moving it into a standalone resource file instead of keeping it inline.
- If needed, validate the generated script artifact separately, for example with `node -c`.

## Workspace Cleanliness

- Keep the repository root clean.
- Do not leave temporary scripts, debugging dumps, extracted HTML, or test logs in the project root.
- Put disposable troubleshooting artifacts under `scripts/` or `temp/`, or delete them immediately after use.

## Architecture Direction

- Preserve the current Auto-only `council -> executor` workflow unless there is an explicit architectural decision to change it.
- Treat shared task state and app-level multi-turn memory as orchestrator responsibilities, not as adapter-specific hidden session behavior.
- Keep adapters thin and deterministic whenever possible.
- If a CLI-specific persistent session is reintroduced in the future, make it adapter-specific and justify it against the current app-level shared-state direction.
