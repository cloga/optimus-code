import { AgentMode } from '../types/SharedTaskContext';

export interface AgentAdapter {
    /**
     * Unique identifier for the agent
     */
    id: string;

    /**
     * Display name in the UI (can include emojis)
     */
    name: string;

    /**
     * Whether the agent is enabled by default or in user settings
     */
    isEnabled: boolean;

    /**
        * Supported capabilities (e.g. ['plan'] or ['plan', 'agent'])
     */
    modes: AgentMode[];

    /**
     * The core execution function that sends the prompt to the tool and returns the response.
     * Optionally accepts an onUpdate callback for streaming output progressively.
     */
    invoke(prompt: string, mode: AgentMode, sessionId?: string, onUpdate?: (chunk: string) => void): Promise<string>;

    /**
     * Forces the agent to stop generating and clear its current queue.
     */
    stop?(): void;

    /**
     * Debug info from the last invoke call (command, cwd, pid, timing).
     */
    lastDebugInfo?: {
        command: string;
        cwd: string;
        pid: number;
        startTime: number;
        endTime?: number;
        promptTransport?: 'inline' | 'file';
        promptFilePath?: string;
        originalPromptLength?: number;
        sentPromptLength?: number;
        promptFileThreshold?: number;
    };

    /**
     * The physical session ID returned by the CLI for resuming context.
     */
    lastSessionId?: string;

    /**
     * Optional normalized usage log captured from the most recent invocation.
     */
    lastUsageLog?: string;

    /**
     * Optional per-adapter thinking/process extraction.
     * If provided, ChatViewProvider will delegate to this instead of the generic parser.
     * Returns thinking (tool trace / reasoning), output (final answer), and optional usageLog separately.
     */
    extractThinking?(rawText: string): { thinking: string; output: string; usageLog?: string };
}
