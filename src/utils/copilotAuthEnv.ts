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
 *
 * Also strips master-scoped BYOM (Bring-Your-Own-Model) env vars so that
 * sub-agent workers are not forced onto the master's custom provider
 * (e.g. Agent Maestro / Gemini). Workers must honor their own
 * role-configured engine/model. Set `OPTIMUS_ALLOW_BYOM_PROPAGATION=1`
 * to opt out of the strip (rare — e.g. all sub-agents should share the
 * master's BYOM endpoint).
 */
const BYOM_ENV_KEYS = [
    'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_BEARER_TOKEN',
    'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_PROVIDER_AZURE_API_VERSION',
    'COPILOT_PROVIDER_MODEL_ID',
    'COPILOT_MODEL',
];

const WINDOWS_PROFILE_ENV_KEYS = [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
];

export function sanitizeCopilotAuthEnv(
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
): void {
    if (!env.COPILOT_GITHUB_TOKEN) {
        // Remove classic PATs (ghp_) — they poison Copilot's auth flow.
        // Keep OAuth tokens (gho_) and fine-grained PATs (github_pat_) intact.
        if (env.GITHUB_TOKEN?.startsWith('ghp_')) {
            delete env.GITHUB_TOKEN;
        }
        if (env.GH_TOKEN?.startsWith('ghp_')) {
            delete env.GH_TOKEN;
        }
    }

    if (env.OPTIMUS_ALLOW_BYOM_PROPAGATION !== '1') {
        for (const key of BYOM_ENV_KEYS) {
            if (env[key] !== undefined) {
                delete env[key];
            }
        }
    }

    // Nested Copilot workers should not inherit the caller's Windows home/profile
    // hints by default. Some user-level Copilot patches and BYOM shims hook off
    // these variables and emit noisy startup warnings (for example Gemini patch
    // probes) even though nested workers do not support that setup. Allow an
    // explicit opt-out for users who intentionally rely on profile propagation.
    if (platform === 'win32' && env.OPTIMUS_ALLOW_COPILOT_PROFILE_PROPAGATION !== '1') {
        for (const key of WINDOWS_PROFILE_ENV_KEYS) {
            if (env[key] !== undefined) {
                delete env[key];
            }
        }
    }
}
