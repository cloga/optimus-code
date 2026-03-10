import { AgentAdapter } from './AgentAdapter';
import { GitHubCopilotAdapter } from './GitHubCopilotAdapter';
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';
import { AgentMode } from '../types/SharedTaskContext';
import { debugLog } from '../debugLogger';

type AdapterKind = 'github-copilot' | 'claude-code';

export interface AgentConfig {
    id: string;
    name: string;
    adapter: AdapterKind;
    model?: string;
    enabled: boolean;
    modes?: AgentMode[];
}

/**
 * Get adapters based on a provided configuration array
 */
export function getActiveAdapters(agentsConfig: AgentConfig[] = []): AgentAdapter[] {
    const adapters: AgentAdapter[] = [];

    for (const agent of agentsConfig) {
        if (!agent.enabled) continue;

        let adapterInstance: AgentAdapter | null = null;
        const modes = agent.modes || ['plan', 'agent'] satisfies AgentMode[];
        if (agent.adapter === 'github-copilot') {
            adapterInstance = new GitHubCopilotAdapter(agent.id, agent.name, agent.model || '', modes);
        } else if (agent.adapter === 'claude-code') {
            adapterInstance = new ClaudeCodeAdapter(agent.id, agent.name, agent.model || '', modes);
        } else {
            debugLog('Adapters', `Unknown adapter type '${agent.adapter}', skipping agent '${agent.id}'`);
        }
        // Future adapters (e.g. 'doubao', 'kimi') can be effortlessly added here

        if (adapterInstance) {
            adapters.push(adapterInstance);
        }
    }

    // Default fallback if config is completely broken or empty
    if (adapters.length === 0) {
        adapters.push(new GitHubCopilotAdapter('github-copilot-default', '🤖 Copilot (Default)'));
    }

    return adapters;
}