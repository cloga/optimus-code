import * as path from 'path';

function normalizeExecutable(executable: string): string {
    return path.basename(executable).toLowerCase();
}

export function isCopilotCliExecutable(executable: string): boolean {
    const normalized = normalizeExecutable(executable);
    return normalized === 'copilot' || normalized === 'copilot.exe' || normalized === 'copilot.cmd';
}

/**
 * Sanitize env for Copilot CLI child processes.
 *
 * Copilot CLI uses its own credential store and does NOT need env tokens.
 * However, if GITHUB_TOKEN contains a classic PAT (ghp_), Copilot will
 * try to use it, fail, and report "Authentication required" instead of
 * falling back to its credential store. So we must remove classic PATs.
 */
export function sanitizeCopilotAuthEnv(env: NodeJS.ProcessEnv): void {
    if (env.COPILOT_GITHUB_TOKEN) {
        return;
    }

    // Remove classic PATs (ghp_) — they poison Copilot's auth flow.
    // Keep OAuth tokens (gho_) and fine-grained PATs (github_pat_) intact.
    if (env.GITHUB_TOKEN?.startsWith('ghp_')) {
        delete env.GITHUB_TOKEN;
    }
    if (env.GH_TOKEN?.startsWith('ghp_')) {
        delete env.GH_TOKEN;
    }
}
