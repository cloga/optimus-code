import { AgentAdapter } from './AgentAdapter';
import * as cp from 'child_process';
import * as util from 'util';
import * as vscode from 'vscode';

const execAsync = util.promisify(cp.exec);

export class ClaudeCodeAdapter implements AgentAdapter {
    id: string;
    name: string;
    isEnabled = true;
    modelFlag: string;

    constructor(id: string = 'claude-code', name: string = '🦉 Claude Code', modelFlag: string = '') {
        this.id = id;
        this.name = name;
        this.modelFlag = modelFlag;
    }

    async invoke(prompt: string, onUpdate?: (chunk: string) => void): Promise<string> {
        let cliPrompt = prompt;
        const safePrompt = cliPrompt.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
        const modelArg = this.modelFlag ? ` --model ${this.modelFlag}` : '';

        return new Promise((resolve, reject) => {
            let fullText = "";
            const currentCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
            const child = cp.spawn(`claude -p "${safePrompt}"${modelArg}`, {
                shell: true,
                cwd: currentCwd,
                env: { ...process.env, TERM: 'dumb', CI: 'true', FORCE_COLOR: '0' }
            });

            child.stdout.on('data', (data) => {
                fullText += data.toString();
                if (onUpdate) onUpdate(fullText);
            });

            child.stderr.on('data', (data) => {
                // Wrap stderr in markdown quote so it looks like "Logs/Thoughts"
                const logLine = data.toString().trim().replace(/^/gm, '> ');
                fullText += `\n${logLine}\n`;
                if (onUpdate) onUpdate(fullText);
            });

            child.on('close', (code) => {
                if (code === 0 || fullText.trim()) {
                    resolve(fullText.trim() || "(No output from Claude)");
                } else {
                    reject(new Error(`Command exited with code ${code}`));
                }
            });

            child.on('error', (err) => {
                reject(new Error(`Integration Error: ${err.message}`));
            });

            // CRITICAL FIX: Claude Code CLI waits indefinitely if stdin is kept open
            if (child.stdin) {
                child.stdin.end();
            }
        });
    }
}
