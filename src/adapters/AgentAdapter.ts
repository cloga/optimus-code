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
     * The core execution function that sends the prompt to the tool and returns the response.
     * Optionally accepts an onUpdate callback for streaming output progressively.
     */
    invoke(prompt: string, onUpdate?: (chunk: string) => void): Promise<string>;
}
