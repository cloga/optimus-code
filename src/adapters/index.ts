import { AgentAdapter } from './AgentAdapter';
import { GitHubCopilotAdapter } from './GitHubCopilotAdapter';
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';
import * as vscode from 'vscode';

interface AgentConfig {
    id: string;
    name: string;
    adapter: 'github-copilot' | 'claude-code' | string; // Keeps the architecture open for any future string
    model?: string;
    enabled: boolean;
}

/**
 * Get all adapters that are dynamically configured and enabled by the user in settings
 */
export function getActiveAdapters(): AgentAdapter[] {
    const config = vscode.workspace.getConfiguration('optimusCode');
    const agentsConfig: AgentConfig[] = config.get('agents') || [];

    const adapters: AgentAdapter[] = [];

    for (const agent of agentsConfig) {
        if (!agent.enabled) continue;

        let adapterInstance: AgentAdapter | null = null;
        if (agent.adapter === 'github-copilot') {
            adapterInstance = new GitHubCopilotAdapter(agent.id, agent.name, agent.model || '');
        } else if (agent.adapter === 'claude-code') {
            adapterInstance = new ClaudeCodeAdapter(agent.id, agent.name, agent.model || '');
        }
        // Future adapters (e.g. 'doubao', 'kimi') can be effortlessly added here
        // else if (agent.adapter === 'your-new-adapter') { ... }

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