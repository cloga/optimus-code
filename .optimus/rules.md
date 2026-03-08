# .optimus/rules.md (Single Source of Truth for Prompts)

This file provides system-wide project-specific instructions for all Agents (Claude, Copilot, etc.) working in this repository.

> This file is the single source of truth for all agent rules.
> Optimus injects these rules into every agent prompt at runtime â€?no file synchronization required.

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

## Publishing VS Code Extension Release

When the executor is asked to publish or release a new version of the extension, follow these steps:

1. **Bump version** in `package.json` following semver (patch for fixes, minor for features, major for breaking changes). Update `CHANGELOG.md` with the release notes.
2. **Commit** the version bump and changelog:
   ```
   git add package.json CHANGELOG.md
   git commit -m "chore: release v<NEW_VERSION>"
   ```
3. **Create and push the tag** â€?this triggers the `.github/workflows/publish.yml` GitHub Action:
   ```
   git tag v<NEW_VERSION>
   git push origin main
   git push origin v<NEW_VERSION>
   ```
4. **Verify** the Action is running at `https://github.com/cloga/optimus-code/actions`. The `Publish to VS Code Marketplace` workflow should appear in progress.
5. Do **not** run `vsce publish` locally â€?the CI workflow handles packaging and publishing using the `VSCE_PAT` secret.
6. If the `VSCE_PAT` secret is not configured in the repository (`Settings â†?Secrets and variables â†?Actions`), notify the user and block the release.

## Architecture Direction

- The system supports three execution modes: **Auto** (planner â†?executor, default), **Plan** (planners only), and **Exec** (executor only). Preserve this routing architecture unless there is an explicit decision to change it.
- Treat shared task state and app-level multi-turn memory as orchestrator responsibilities, not as adapter-specific hidden session behavior.
- Keep adapters thin and deterministic whenever possible.
- If a CLI-specific persistent session is reintroduced in the future, make it adapter-specific and justify it against the current app-level shared-state direction.



When calling `delegate_task`, pass one of the following exact strings in the `role_prompt` parameter:
1. `pm`: **Product Manager**. Call this agent first for epic/large features. The PM will talk to you, write the `REQUIREMENTS.md` / `PRD.md`, and return control.
2. `architect`: **System Architect**. Call this agent after the PM. It reads the PRD, designs the system, choosing frameworks, and writes `ARCHITECTURE.md` and `.optimus/TASKS.todo`. 
3. `dev`: **Software Developer**. Call this agent to execute specific tickets from the `TASKS.todo` list. It writes the actual TypeScript/Python source code.
4. `qa`: **Quality Assurance**. Call this agent to review the `dev`'s pull request or code, and to write unit tests.


## Orchestrator Skills
- As the Main Agent, you should utilize the delegate_task tool when handling tasks that require multiple steps, architecture design, or writing extensive code. Refer to your internal plugin instructions (loaded from esources/plugins/skills/delegate_task.md) for how to dispatch work.
