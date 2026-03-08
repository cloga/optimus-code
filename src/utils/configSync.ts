import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../debugLogger';

export function syncOptimusInstructions(workspaceRoot: string) {
    const optimusPath = path.join(workspaceRoot, '.optimus', 'rules.md');
    
    if (!fs.existsSync(optimusPath)) {
        return;
    }

    try {
        const content = fs.readFileSync(optimusPath, 'utf8');

        // Sync to Claude
        const claudeDir = path.join(workspaceRoot, '.claude');
        if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
        }
        fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), content, 'utf8');

        // Sync to Copilot
        const githubDir = path.join(workspaceRoot, '.github');
        if (!fs.existsSync(githubDir)) {
            fs.mkdirSync(githubDir, { recursive: true });
        }
        fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), content, 'utf8');
        
        debugLog('ConfigSync', 'Instructions synced successfully from .optimus/rules.md.');
    } catch (e) {
        debugLog('ConfigSync', 'Failed to sync .optimus/rules.md', String(e));
    }
}
