export const AUTOMATION_MODE_VALUES = [
    'interactive',
    'plan',
    'accept-edits',
    'deny-unapproved',
    'auto-approve',
] as const;

export const AUTOMATION_CONTINUATION_VALUES = [
    'single',
    'autopilot',
] as const;

export type AutomationMode = typeof AUTOMATION_MODE_VALUES[number];
export type AutomationContinuation = typeof AUTOMATION_CONTINUATION_VALUES[number];

export type ClaudePermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan';

export type RawAutomationConfig = {
    mode?: unknown;
    continuation?: unknown;
    max_continues?: unknown;
};

export type NormalizedAutomationPolicy = {
    mode: AutomationMode;
    continuation: AutomationContinuation;
    maxContinues?: number;
};

const LEGACY_MODE_ALIASES: Record<string, AutomationMode> = {
    default: 'interactive',
    plan: 'plan',
    acceptEdits: 'accept-edits',
    dontAsk: 'deny-unapproved',
    bypassPermissions: 'auto-approve',
    autopilot: 'auto-approve',
};

function isAutomationMode(value: unknown): value is AutomationMode {
    return typeof value === 'string' && (AUTOMATION_MODE_VALUES as readonly string[]).includes(value);
}

function isAutomationContinuation(value: unknown): value is AutomationContinuation {
    return typeof value === 'string' && (AUTOMATION_CONTINUATION_VALUES as readonly string[]).includes(value);
}

function normalizeMode(value: unknown): AutomationMode {
    if (isAutomationMode(value)) {
        return value;
    }
    if (typeof value === 'string' && LEGACY_MODE_ALIASES[value]) {
        return LEGACY_MODE_ALIASES[value];
    }
    return 'interactive';
}

function normalizeContinuation(value: unknown, rawMode: unknown): AutomationContinuation {
    if (isAutomationContinuation(value)) {
        return value;
    }
    if (rawMode === 'autopilot') {
        return 'autopilot';
    }
    return 'single';
}

function normalizeMaxContinues(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    return undefined;
}

export function normalizeAutomationPolicy(raw?: RawAutomationConfig | null): NormalizedAutomationPolicy {
    return {
        mode: normalizeMode(raw?.mode),
        continuation: normalizeContinuation(raw?.continuation, raw?.mode),
        maxContinues: normalizeMaxContinues(raw?.max_continues),
    };
}

export function getAutomationCapabilityMode(raw?: RawAutomationConfig | null): AutomationMode {
    return normalizeAutomationPolicy(raw).mode;
}

export function getClaudePermissionModeForPolicy(raw?: RawAutomationConfig | null): ClaudePermissionMode {
    const { mode } = normalizeAutomationPolicy(raw);
    switch (mode) {
        case 'plan':
            return 'plan';
        case 'accept-edits':
            return 'acceptEdits';
        case 'deny-unapproved':
            return 'dontAsk';
        case 'auto-approve':
            return 'bypassPermissions';
        case 'interactive':
        default:
            return 'default';
    }
}

export function getClaudeCliAutomationArgs(executionMode: 'plan' | 'agent', raw?: RawAutomationConfig | null): string[] {
    const permissionMode = executionMode === 'plan' ? 'plan' : getClaudePermissionModeForPolicy(raw);
    const args: string[] = [];
    if (permissionMode === 'bypassPermissions') {
        args.push('--allow-dangerously-skip-permissions');
    }
    args.push('--permission-mode', permissionMode);
    return args;
}

export function getCopilotCliAutomationArgs(executionMode: 'plan' | 'agent', raw?: RawAutomationConfig | null): string[] {
    if (executionMode !== 'agent') {
        return [];
    }

    const policy = normalizeAutomationPolicy(raw);
    const args: string[] = [];

    if (policy.mode === 'auto-approve') {
        args.push('--allow-all', '--no-ask-user');
    }

    if (policy.continuation === 'autopilot') {
        args.push('--autopilot');
        if (typeof policy.maxContinues === 'number') {
            args.push('--max-autopilot-continues', String(policy.maxContinues));
        }
    }

    return args;
}

export const AUTOMATION_MODE_DESCRIPTIONS: Record<AutomationMode, string> = {
    interactive: 'Prompt before sensitive actions using the vendor default approval flow.',
    plan: 'Read-only planning mode with no file edits or command execution.',
    'accept-edits': 'Auto-approve file edits while keeping command-side effects guarded where the transport supports that split.',
    'deny-unapproved': 'Never ask interactively; deny tools unless they were pre-approved in config or policy rules.',
    'auto-approve': 'Run autonomously by auto-approving or bypassing permission prompts where the transport supports it.',
};