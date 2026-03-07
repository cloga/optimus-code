import { PersistentAgentAdapter } from './PersistentAgentAdapter';

export class ClaudeCodeAdapter extends PersistentAgentAdapter {
    constructor(id: string = 'claude-code', name: string = '🦖 Claude Code', modelFlag: string = '') {
        // Claude uses ? or > or something similar for input. We assume "> " for now.
        super(id, name, modelFlag, '>'); 
    }

    protected getSpawnCommand(mode: string): { cmd: string, args: string[] } {
        const args: string[] = [];
        if (this.modelFlag) {
            args.push('--model', this.modelFlag);
        }

        // Map UI modes to Claude's permission modes
        if (mode === 'plan' || mode === 'ask') {
            args.push('--permission-mode', 'plan');
        } else if (mode === 'agent') {
            args.push('--dangerously-skip-permissions');
        }

        return { cmd: 'claude', args };
    }
}
