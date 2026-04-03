/**
 * Generic Agent Executor — decoupled from Optimus orchestration.
 *
 * Provides a minimal prompt → result execution path using ACP adapters.
 * No dependency on: T1/T2/T3 tiers, role templates, skills, memory,
 * TaskManifestManager, or .optimus/ directory structure.
 */
import { AcpProcessPool } from '../utils/acpProcessPool';
import { AcpAdapter } from '../adapters/AcpAdapter';
import { extractJsonFromText } from '../utils/agentRuntime';
import { validateOutput, formatValidationIssues } from '../harness/outputValidator';
import { getEngineConfig, buildResolvedTransportForProtocol, loadEngineActivityTimeout } from '../mcp/engine-resolver';

// ─── Engine Configuration ───

export interface EngineConfig {
    executable: string;
    args: string[];
    activityTimeoutMs: number;
}

/** Built-in engine defaults — no config file needed. */
const BUILTIN_ENGINES: Record<string, EngineConfig> = {
    'github-copilot': {
        executable: 'copilot',
        args: ['--acp', '--stdio'],
        activityTimeoutMs: 300_000,
    },
    'claude-code':{
        executable: 'claude-agent-acp',
        args: ['--acp', '--stdio'],
        activityTimeoutMs: 300_000,
    },
};

export function getBuiltinEngines(): string[] {
    return Object.keys(BUILTIN_ENGINES);
}

export function resolveEngineConfig(engine: string): EngineConfig {
    const config = BUILTIN_ENGINES[engine];
    if (!config) {
        const available = Object.keys(BUILTIN_ENGINES).join(', ');
        throw new Error(
            `Unknown engine '${engine}'. Available engines: ${available}. ` +
            `Fix: use one of the built-in engines or configure a custom engine.`
        );
    }
    return config;
}

// ─── Execution ───

export interface ExecuteOptions {
    engine?: string;
    model?: string;
    /** Agent mode: 'agent' (default) or 'plan' */
    mode?: 'agent' | 'plan';
    sessionId?: string;
    autopilot?: boolean;
    maxContinues?: number;
    timeoutMs?: number;
    outputSchema?: unknown;
    /** Extra environment variables passed to the adapter process */
    extraEnv?: Record<string, string>;
    /** Role name for validation context (defaults to 'generic') */
    role?: string;
    /** Verification strictness: 'strict' | 'normal' | 'skip' */
    verificationLevel?: 'strict' | 'normal' | 'skip';
    /** Streaming callback: called for each output chunk during execution */
    onChunk?: (chunk: string, isThinking: boolean) => void;
    /** Workspace path — when provided, loads engine config from available-agents.json instead of using hardcoded defaults */
    workspacePath?: string;
}

export interface ExecuteResult {
    output: string;
    parsed?: unknown;
    parseError?: string;
    validationWarnings?: string[];
    sessionId?: string;
    stopReason?: string;
    usage?: Record<string, unknown>;
    durationMs: number;
}

/**
 * Execute a prompt against an ACP engine and return the result.
 * This is the core generic execution path — no Optimus dependencies.
 */
export async function executePrompt(
    prompt: string,
    options: ExecuteOptions = {}
): Promise<ExecuteResult> {
    const engine = options.engine || 'github-copilot';

    // Resolve engine executable, args, and activity timeout.
    // When workspacePath is provided, prefer config from available-agents.json;
    // otherwise fall back to hardcoded BUILTIN_ENGINES defaults.
    let executable: string;
    let args: string[];
    let activityTimeoutMs: number;

    if (options.workspacePath) {
        const engineConfig = getEngineConfig(engine, options.workspacePath);
        if (engineConfig) {
            const transport = buildResolvedTransportForProtocol(engine, 'acp', engineConfig?.acp || engineConfig, options.model);
            executable = transport.executable || engineConfig?.acp?.path || BUILTIN_ENGINES[engine]?.executable || 'copilot';
            args = transport.args;
            activityTimeoutMs = loadEngineActivityTimeout(options.workspacePath, engine) || BUILTIN_ENGINES[engine]?.activityTimeoutMs || 300_000;
        } else {
            const config = resolveEngineConfig(engine);
            executable = config.executable;
            args = config.args;
            activityTimeoutMs = config.activityTimeoutMs;
        }
    } else {
        const config = resolveEngineConfig(engine);
        executable = config.executable;
        args = config.args;
        activityTimeoutMs = config.activityTimeoutMs;
    }

    const pool = AcpProcessPool.getInstance();
    const adapter = pool.getOrCreateAdapter(
        engine,
        executable,
        args,
        activityTimeoutMs
    );

    const acpOptions: Record<string, unknown> = {
        autopilot: options.autopilot ?? true,
        maxContinues: options.maxContinues ?? 8,
    };
    if (options.model) {
        acpOptions.model = options.model;
    }

    // Build prompt with output schema instructions if provided
    const fullPrompt = options.outputSchema
        ? `${prompt}\n\n## Output Contract\nReturn ONLY valid JSON matching this schema:\n\n\`\`\`json\n${JSON.stringify(options.outputSchema, null, 2)}\n\`\`\`\n`
        : prompt;

    const startTime = Date.now();

    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = options.timeoutMs
        ? new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => {
                reject(new Error(
                    `Execution timed out after ${options.timeoutMs}ms. ` +
                    `Fix: increase timeout_ms or simplify the prompt.`
                ));
            }, options.timeoutMs);
        })
        : null;

    try {
        const onUpdate = options.onChunk
            ? (chunk: string) => {
                const isThinking = chunk.startsWith('[thinking] ');
                options.onChunk!(isThinking ? chunk.slice(11) : chunk, isThinking);
            }
            : undefined;

        const invokePromise = adapter.invoke(
            fullPrompt,
            options.mode || 'agent',
            options.sessionId,
            onUpdate,
            options.extraEnv,
            acpOptions
        );

        const rawOutput = timeoutPromise
            ? await Promise.race([invokePromise, timeoutPromise])
            : await invokePromise;

        const durationMs = Date.now() - startTime;

        // Parse output
        let parsed: unknown;
        let parseError: string | undefined;
        if (options.outputSchema !== undefined) {
            try {
                parsed = JSON.parse(rawOutput);
            } catch {
                const extracted = extractJsonFromText(rawOutput);
                if (extracted !== undefined) {
                    parsed = extracted;
                } else {
                    parseError = 'Response is not valid JSON. Tried code fence and brace-matching extraction.';
                }
            }
        }

        // ── Harness: Output Validation Gate ──
        const verifyLevel = options.verificationLevel || 'normal';
        const validation = validateOutput(
            parsed !== undefined ? JSON.stringify(parsed) : rawOutput,
            {
                role: options.role || 'generic',
                outputSchema: options.outputSchema as object | undefined,
                outputPath: '',
                engine,
                verificationLevel: verifyLevel,
            }
        );
        let validationWarnings: string[] | undefined;
        if (validation.severity === 'fail') {
            parseError = (parseError ? parseError + '\n' : '') +
                'Output validation failed:\n' + formatValidationIssues(validation.issues);
        } else if (validation.issues.length > 0) {
            validationWarnings = validation.issues.map(i => `[${i.severity}] ${i.rule}: ${i.message}`);
        }

        return {
            output: parsed !== undefined ? JSON.stringify(parsed, null, 2) : rawOutput,
            parsed,
            parseError,
            validationWarnings,
            sessionId: adapter.lastSessionId,
            stopReason: adapter.lastStopReason,
            usage: adapter.lastUsageLog ? tryParseJson(adapter.lastUsageLog) : undefined,
            durationMs,
        };
    } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
    }
}

function tryParseJson(s: string): Record<string, unknown> | undefined {
    try { return JSON.parse(s); } catch { return undefined; }
}
