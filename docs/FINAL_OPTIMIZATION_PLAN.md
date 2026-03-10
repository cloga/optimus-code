# Final AI Response Optimization Plan

## Objective
Optimize the AI agent's responses to be clear, concise, and helpful by implementing a unified response strategy across all execution paths.

## Source Analysis
This plan synthesizes recommendations from three AI models:
- **Claude Opus 4.6 1m**: Suggested structured output, prompt architecture changes, and post-processing improvements.
- **Copilot Gemini 3.0 Pro**: Focused on direct response guidelines and orchestrator prompt refinement.
- **Copilot GPT-5.4**: Proposed a "Response Contract" in prompts, separation of execution/response instructions, and UI cleanup.

## The Strategy

### 1. Unified Response Contract (High Priority)
Inject a standardized "Response Guidelines" section into all executor prompts (`SharedTaskStateManager.ts`). This ensures consistent behavior regardless of the execution path.

**Guidelines:**
- **Answer First**: Lead with the direct answer or result.
- **Conciseness**: Avoid filler words ("Here is the code", "I have completed...").
- **Structure**: Use bullet points for lists and steps.
- **Context**: Do not repeat the user's request or task context unless necessary for clarity.
- **Technical Detail**: Prioritize code snippets and "why" explanations over narration.

### 2. Orchestrator Optimization (Medium Priority)
Refine the orchestrator prompt in `ChatViewProvider.ts` to discourage "chatty" delegation messages and focus on synthesized results.

### 3. UI/Display Cleanup (Low Priority - Future)
Enhance `cleanForDisplay()` to strip specific patterns (e.g., `<task-summary>`) before showing the final message to the user, while keeping them for memory.

## Implementation Plan

1.  **Modify `src/managers/SharedTaskStateManager.ts`**:
    - Add `RESPONSE GUIDELINES` to `buildDirectExecutorPrompt` and `buildExecutorPrompt`.
    - Distinctly separate execution rules from response style rules.

2.  **Modify `src/providers/ChatViewProvider.ts`**:
    - Update the orchestrator prompt to enforce brevity during delegation.

3.  **Validation**:
    - Rebuild the extension.
    - Verify that responses are more direct and less verbose.
