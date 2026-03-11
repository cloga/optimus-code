import { PersistentAgentAdapter } from './PersistentAgentAdapter';
import { AgentMode } from '../types/SharedTaskContext';
// Claude CLI process line prefixes: spinning indicator (⏺), bullets (•), tree chars (└│├)
const CLAUDE_PROCESS_LINE_RE = /^[⏺●•└│├↳✓✗]/;

export class ClaudeCodeAdapter extends PersistentAgentAdapter {
    constructor(id: string = 'claude-code', name: string = '🦖 Claude Code', modelFlag: string = '', modes?: AgentMode[]) {
        super(id, name, modelFlag, '>', modes);
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
        const fs = require('fs');
        const path = require('path');
        
        args.push('--add-dir', cwd);

        // Auto-detect and isolate local MCP context specifically for Claude-code -> prevents "128 tools" global bug
        const localMcpPath = path.join(cwd, '.vscode', 'mcp.json');
        if (fs.existsSync(localMcpPath)) {
            try {
                let mcpContent = fs.readFileSync(localMcpPath, 'utf8');
                // Replace VS Code specific macros with absolute paths so Claude can execute them
                mcpContent = mcpContent.replace(/\$\{workspaceFolder\}/g, cwd.replace(/\\/g, '/'));
                const localMcp = JSON.parse(mcpContent);
                // Normalize "servers" -> "mcpServers" for Claude
                const claudeMcp = { mcpServers: localMcp.servers || localMcp.mcpServers || {} };
                const proxyMcpPath = path.join(cwd, '.optimus', '.claude-mcp.json');
                fs.mkdirSync(path.dirname(proxyMcpPath), { recursive: true });
                fs.writeFileSync(proxyMcpPath, JSON.stringify(claudeMcp, null, 2));
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
            args.push('--permission-mode', 'plan');
        } else if (mode === 'agent') {
            args.push('--dangerously-skip-permissions');
        }

        return { cmd: 'claude', args };
    }
}
