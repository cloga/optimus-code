import * as path from 'path';

function normalizeExecutable(executable: string): string {
    return path.basename(executable).toLowerCase();
}

export function isCopilotCliExecutable(executable: string): boolean {
    const normalized = normalizeExecutable(executable);
    return normalized === 'copilot' || normalized === 'copilot.exe' || normalized === 'copilot.cmd';
}

export function sanitizeCopilotAuthEnv(env: NodeJS.ProcessEnv): void {
    if (env.COPILOT_GITHUB_TOKEN) {
        return;
    }

    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
}
