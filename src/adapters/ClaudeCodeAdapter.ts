import { PersistentAgentAdapter } from './PersistentAgentAdapter';
import { AgentMode } from '../types/SharedTaskContext';
import { ClaudePermissionMode, getClaudeCliAutomationArgs } from '../utils/automationPolicy';
import * as fs from 'fs';
import * as path from 'path';
import { loadProjectMcpServers } from '../utils/mcpConfig';
import { resolveOptimusPath } from '../utils/worktree';
// Claude CLI process line prefixes: spinning indicator (⏺), bullets (•), tree chars (└│├)
const CLAUDE_PROCESS_LINE_RE = /^[⏺●•└│├↳✓✗]/;

type ClaudeCodeAdapterOptions = {
    permissionMode?: ClaudePermissionMode;
};

export class ClaudeCodeAdapter extends PersistentAgentAdapter {
    private readonly agentPermissionMode?: ClaudePermissionMode;

    constructor(id: string = 'claude-code', name: string = '🦖 Claude Code', modelFlag: string = '', modes?: AgentMode[], options?: ClaudeCodeAdapterOptions) {
        super(id, name, modelFlag, '>', modes);
        this.agentPermissionMode = options?.permissionMode;
    }

    protected shouldUsePersistentSession(mode: AgentMode): boolean {
        return false;
    }

    protected shouldUseStructuredOutput(mode: AgentMode): boolean {
        return mode === 'plan' || mode === 'agent';
    }

    protected getNonInteractiveCommand(mode: AgentMode, prompt: string, sessionId?: string): { cmd: string, args: string[] } {
        const command = super.getNonInteractiveCommand(mode, prompt, sessionId);
        if (this.shouldUseStructuredOutput(mode)) {
            command.args.push('--output-format', 'stream-json', '--include-partial-messages', '--verbose');
        }
        if (sessionId) {
            command.args.push('--resume', sessionId);
        }
        return command;
    }

    protected extractStructuredUsageLog(event: any): string | undefined {
        if (event?.type !== 'result' || !event?.usage) {
            return undefined;
        }

        const usage = event.usage;
        const lines = [
            typeof usage.input_tokens === 'number' ? `Input tokens: ${usage.input_tokens}` : '',
            typeof usage.output_tokens === 'number' ? `Output tokens: ${usage.output_tokens}` : '',
            typeof event.total_cost_usd === 'number' ? `Cost: $${event.total_cost_usd.toFixed(6)}` : '',
            typeof event.duration_ms === 'number' ? `Duration: ${event.duration_ms}ms` : '',
            event.modelUsage ? `Model usage: ${JSON.stringify(event.modelUsage)}` : '',
        ].filter(Boolean);

        return lines.length > 0 ? lines.join('\n') : undefined;
    }

    extractThinking(rawText: string): { thinking: string; output: string } {
        return this.extractThinkingWithSharedParser(rawText, {
            processLineRe: CLAUDE_PROCESS_LINE_RE,
            captureProcessLinesAfterOutputStarts: true,
        });
    }

    protected getSpawnCommand(mode: AgentMode): { cmd: string, args: string[] } {
        const args: string[] = [];
        const cwd = PersistentAgentAdapter.getWorkspacePath();
        
        args.push('--add-dir', cwd);

        // Prefer the canonical Optimus MCP config, then fall back to legacy client files.
        const projectMcpServers = loadProjectMcpServers(cwd, 'claude');
        if (projectMcpServers) {
            try {
                const proxyMcpPath = resolveOptimusPath(cwd, 'state', '.claude-mcp.json');
                fs.mkdirSync(path.dirname(proxyMcpPath), { recursive: true });
                fs.writeFileSync(proxyMcpPath, JSON.stringify({ mcpServers: projectMcpServers }, null, 2));
                args.push('--mcp-config', proxyMcpPath);
            } catch (e) {
                // Silently ignore parse errors
            }
            args.push('--strict-mcp-config');
        } else {
            // Strictly isolate to prevent global leaky MCP tools from causing 500 error if there's no project config
            args.push('--strict-mcp-config'); 
        }

        if (this.modelFlag) {
            args.push('--model', this.modelFlag);
        }

        if (mode === 'plan') {
            args.push(...getClaudeCliAutomationArgs('plan'));
        } else if (mode === 'agent') {
            args.push(...getClaudeCliAutomationArgs('agent', {
                mode: this.agentPermissionMode || 'auto-approve'
            }));
        }

        return { cmd: 'claude', args };
    }
}
