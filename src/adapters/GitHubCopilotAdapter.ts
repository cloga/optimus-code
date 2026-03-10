import { PersistentAgentAdapter } from './PersistentAgentAdapter';
import { AgentMode } from '../types/SharedTaskContext';
import * as fs from 'fs';
import * as path from 'path';
// Copilot CLI uses ● (U+25CF filled circle) and tree-drawing chars for tool trace lines
// Also handle ⏺ (U+23FA) and • (U+2022) for robustness
const COPILOT_PROCESS_LINE_RE = /^[●⏺•└│├▶→↳✓✗]/;

export class GitHubCopilotAdapter extends PersistentAgentAdapter {
    constructor(id: string = 'github-copilot', name: string = '🛸 GitHub Copilot', modelFlag: string = '', modes?: AgentMode[]) {
        super(id, name, modelFlag, '?>', modes);
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
            command.args.push('--output-format', 'json', '--stream', 'on');
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
            typeof usage.premiumRequests === 'number' ? `Premium requests: ${usage.premiumRequests}` : '',
            typeof usage.totalApiDurationMs === 'number' ? `API duration: ${usage.totalApiDurationMs}ms` : '',
            typeof usage.sessionDurationMs === 'number' ? `Session duration: ${usage.sessionDurationMs}ms` : '',
            usage.codeChanges ? `Code changes: ${JSON.stringify(usage.codeChanges)}` : '',
        ].filter(Boolean);

        return lines.length > 0 ? lines.join('\n') : undefined;
    }

    extractThinking(rawText: string): { thinking: string; output: string; usageLog?: string } {
        return this.extractThinkingWithSharedParser(rawText, {
            processLineRe: COPILOT_PROCESS_LINE_RE,
            captureBracketLines: true,
            captureProcessLinesAfterOutputStarts: true,
            collectUsageLog: true,
        });
    }

    protected getSpawnCommand(mode: AgentMode): { cmd: string, args: string[] } {
        const args: string[] = [];
        const cwd = PersistentAgentAdapter.getWorkspacePath();
        args.push('--add-dir', cwd);

        if (this.modelFlag) {
            args.push('--model', this.modelFlag);
        }

        if (mode === 'plan') {
            // -p flag already prevents file modifications; no extra flags needed
        } else if (mode === 'agent') {
            args.push('--allow-all');
            args.push('--no-ask-user');
        }

        return { cmd: 'copilot', args };
    }
}
