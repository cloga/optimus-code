import { PersistentAgentAdapter } from './PersistentAgentAdapter';

export class GitHubCopilotAdapter extends PersistentAgentAdapter {
    constructor(id: string = 'github-copilot', name: string = '🛸 GitHub Copilot', modelFlag: string = '') {
        // Copilot asks for "What would you like to do?" then prompts
        super(id, name, modelFlag, '?>'); 
    }

    protected getSpawnCommand(mode: string): { cmd: string, args: string[] } {
        const args: string[] = [];
        
        // Map modes conceptually for Copilot
        if (mode === 'plan' || mode === 'ask') {
            // Give context that it shouldn't modify
            args.push('--excluded-tools', 'write', 'shell');
        } else if (mode === 'agent') {
            args.push('--allow-all'); // Enable all permissions fully automatically
            args.push('--no-ask-user'); // Prevent it from halting to await human clarification
        }
        
        return { cmd: 'copilot', args };
    }
}
