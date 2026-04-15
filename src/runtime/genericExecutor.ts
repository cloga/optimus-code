/**
 * Generic Agent Executor — decoupled from Optimus orchestration.
 *
 * Provides a minimal prompt → result execution path using ACP adapters.
 * No dependency on: T1/T2/T3 tiers, role templates, skills, memory,
 * TaskManifestManager, or .optimus/ directory structure.
 *
 * When the target engine would create a nested process conflict (e.g. spawning
 * copilot inside a copilot host), execution is transparently routed through
 * an auto-started runtime HTTP server to avoid auth issues.
 */
import { AcpProcessPool } from '../utils/acpProcessPool';
import { AcpAdapter } from '../adapters/AcpAdapter';
import { extractJsonFromText } from '../utils/agentRuntime';
import { validateOutput, formatValidationIssues } from '../harness/outputValidator';
import { getEngineConfig, buildResolvedTransportForProtocol, loadEngineActivityTimeout, loadEngineHeartbeatTimeout } from '../mcp/engine-resolver';
import { isCopilotCliExecutable } from '../utils/copilotAuthEnv';
import http from 'http';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

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

// ─── Runtime Server Proxy (for nested-engine conflict avoidance) ───

const RUNTIME_PORT = parseInt(process.env.OPTIMUS_RUNTIME_PORT || '3100', 10);
const RUNTIME_PROXY_TIMEOUT_GRACE_MS = 30_000;
let runtimeServerProcess: ChildProcess | null = null;
let runtimeServerReady = false;
let runtimeServerStarting: Promise<void> | null = null;

export function isRuntimeServerProcess(argv1 = process.argv[1], env = process.env): boolean {
    const scriptName = path.basename(argv1 || '').toLowerCase();
    return env.OPTIMUS_RUNTIME_SERVER === '1' || scriptName === 'http-runtime.js';
}

export function shouldRouteViaRuntimeServer(argv1 = process.argv[1], env = process.env): boolean {
    return !isRuntimeServerProcess(argv1, env) && !process.stdin.isTTY;
}

export function resolveRuntimeProxyTimeoutMs(timeoutMs: number | undefined, activityTimeoutMs: number): number {
    const baseTimeoutMs = timeoutMs && timeoutMs > 0 ? timeoutMs : activityTimeoutMs;
    return Math.max(30_000, baseTimeoutMs + RUNTIME_PROXY_TIMEOUT_GRACE_MS);
}

/**
 * Detect if spawning the given executable would create a nested-engine conflict.
 * This happens when the MCP server runs inside a Copilot CLI host process
 * and the target engine is also copilot — the child process can't authenticate
 * because the parent already holds the credential.
 */
function wouldCauseNestedConflict(executable: string): boolean {
    if (!isCopilotCliExecutable(executable)) return false;
    // Check if our parent process is also copilot
    // Copilot CLI sets specific env vars or we can detect by parent process name.
    // Most reliable: check if we're running as an MCP server inside copilot
    // by looking for COPILOT_* env vars or the parent process chain.
    const parentIsCopilot = !!(
        process.env.COPILOT_AGENT ||
        process.env.GITHUB_COPILOT_RUNTIME ||
        // If the MCP server was spawned by copilot, __dirname contains the dist path
        // and process.ppid's command would be copilot. Check a simpler heuristic:
        // if we're in an MCP server context (not HTTP server, not CLI), we're likely inside copilot/claude
        process.env.MCP_SERVER_NAME
    );
    // Fallback: check if stdin is a pipe (MCP stdio transport = we're inside a host)
    // and the executable resolves to copilot
    if (parentIsCopilot) return true;
    // Conservative: if stdin is not a TTY, we're likely running as MCP server inside a host
    return !process.stdin.isTTY;
}

/**
 * Ensure the runtime HTTP server is running. Auto-starts it if needed.
 * Returns true when the server is ready to accept requests.
 */
export async function ensureRuntimeServer(workspacePath?: string): Promise<boolean> {
    if (runtimeServerReady) return true;
    if (runtimeServerStarting) {
        await runtimeServerStarting;
        return runtimeServerReady;
    }

    // Check if server is already running (from a previous session or manual start)
    try {
        const isUp = await httpGet(`http://127.0.0.1:${RUNTIME_PORT}/api/v2/health`);
        if (isUp) {
            runtimeServerReady = true;
            console.error(`[RuntimeProxy] Runtime server already running on :${RUNTIME_PORT}`);
            return true;
        }
    } catch { /* not running */ }

    // Auto-start the runtime server
    runtimeServerStarting = (async () => {
        const cwd = workspacePath || process.cwd();

        // Find http-runtime.js: prioritize user-level, then project-level
        const homeDir = process.env.USERPROFILE || process.env.HOME || '';
        const candidates = [
            // User-level (cross-project, preferred)
            path.join(homeDir, '.optimus', 'dist', 'http-runtime.js'),
            // Same dist dir as MCP server bundle
            path.join(__dirname, 'http-runtime.js'),
            path.join(__dirname, '..', 'dist', 'http-runtime.js'),
            // Project-level fallback
            path.resolve(cwd, '.optimus', 'dist', 'http-runtime.js'),
            path.resolve(cwd, 'optimus-plugin', 'dist', 'http-runtime.js'),
        ];
        const httpRuntimePath = candidates.find(p => {
            try { return require('fs').existsSync(p); } catch { return false; }
        });
        if (!httpRuntimePath) {
            console.error(`[RuntimeProxy] Cannot find http-runtime.js. Tried: ${candidates.join(', ')}`);
            return;
        }

        console.error(`[RuntimeProxy] Auto-starting runtime server on :${RUNTIME_PORT} (cwd=${cwd})`);

        runtimeServerProcess = spawn(process.execPath, [
            httpRuntimePath,
            '--port', String(RUNTIME_PORT),
        ], {
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
            env: { ...process.env, OPTIMUS_RUNTIME_SERVER: '1' },
        });
        runtimeServerProcess.unref();

        // Wait for the server to become ready (max 15s), with early exit on crash
        const deadline = Date.now() + 15_000;
        let lastStderr = '';
        let processExited = false;
        let exitCode: number | null = null;

        runtimeServerProcess.stderr?.on('data', (chunk: Buffer) => {
            lastStderr += chunk.toString();
        });
        runtimeServerProcess.on('exit', (code) => {
            processExited = true;
            exitCode = code;
        });

        while (Date.now() < deadline && !processExited) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const isUp = await httpGet(`http://127.0.0.1:${RUNTIME_PORT}/api/v2/health`);
                if (isUp) {
                    runtimeServerReady = true;
                    console.error(`[RuntimeProxy] Runtime server ready on :${RUNTIME_PORT}`);
                    return;
                }
            } catch { /* not ready yet */ }
        }

        if (processExited) {
            console.error(`[RuntimeProxy] Runtime server process exited during startup (code=${exitCode}). Stderr: ${lastStderr.slice(-300)}`);
        } else {
            console.error(`[RuntimeProxy] Runtime server failed to start within 15s. Last stderr: ${lastStderr.slice(-300)}`);
        }
    })();

    try {
        await runtimeServerStarting;
    } finally {
        runtimeServerStarting = null;
    }
    return runtimeServerReady;
}

/** Simple HTTP GET that resolves true if status 200, false otherwise */
function httpGet(url: string): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
            res.resume(); // drain
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

/** Execute a prompt via the runtime HTTP server (v2 API) */
async function executeViaRuntimeServer(
    prompt: string,
    options: ExecuteOptions,
    proxyTimeoutMs: number
): Promise<ExecuteResult> {
    const startTime = Date.now();
    const body = JSON.stringify({
        prompt,
        engine: options.engine,
        model: options.model,
        session_id: options.sessionId,
        timeout_ms: options.timeoutMs,
        workspace_path: options.workspacePath,
    });

    return new Promise<ExecuteResult>((resolve, reject) => {
        let settled = false;
        let proxyTimer: NodeJS.Timeout | undefined;
        const finishReject = (err: Error) => {
            if (settled) return;
            settled = true;
            if (proxyTimer) clearTimeout(proxyTimer);
            reject(err);
        };
        const finishResolve = (result: ExecuteResult) => {
            if (settled) return;
            settled = true;
            if (proxyTimer) clearTimeout(proxyTimer);
            resolve(result);
        };

        const req = http.request({
            hostname: '127.0.0.1',
            port: RUNTIME_PORT,
            path: '/api/v2/agent/run',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: proxyTimeoutMs,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const durationMs = Date.now() - startTime;
                try {
                    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (envelope.status === 'completed') {
                        const output = typeof envelope.result === 'string'
                            ? envelope.result
                            : JSON.stringify(envelope.result, null, 2);
                        finishResolve({
                            output,
                            parsed: typeof envelope.result !== 'string' ? envelope.result : undefined,
                            sessionId: envelope.metadata?.session_id,
                            stopReason: envelope.metadata?.stop_reason,
                            usage: envelope.metadata?.usage,
                            durationMs,
                        });
                    } else {
                        finishReject(new Error(
                            `Runtime server returned status '${envelope.status}': ${envelope.error?.message || 'unknown error'}. ` +
                            `Fix: ${envelope.error?.fix || 'check runtime server logs'}`
                        ));
                    }
                } catch (e: any) {
                    finishReject(new Error(`Failed to parse runtime server response: ${e.message}`));
                }
            });
        });
        proxyTimer = setTimeout(() => {
            req.destroy();
            finishReject(new Error(
                `Runtime server proxy timed out after ${proxyTimeoutMs}ms. ` +
                `Fix: increase timeout_ms, reduce runtime concurrency, or inspect runtime server logs.`
            ));
        }, proxyTimeoutMs);
        req.on('timeout', () => {
            req.destroy();
            finishReject(new Error(
                `Runtime server proxy timed out after ${proxyTimeoutMs}ms. ` +
                `Fix: increase timeout_ms, reduce runtime concurrency, or inspect runtime server logs.`
            ));
        });
        req.on('error', (err) => {
            finishReject(new Error(
                `Runtime server proxy failed: ${err.message}. ` +
                `Fix: ensure runtime server is running on port ${RUNTIME_PORT} (node .optimus/dist/http-runtime.js --port ${RUNTIME_PORT})`
            ));
        });
        req.write(body);
        req.end();
    });
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
    /** Optional prompt cache parts for LLM API prompt caching optimization */
    promptParts?: {
        /** Shared prefix (cacheable across parallel workers) */
        sharedPrefix: string;
        /** Unique suffix (per-worker content) */
        uniqueSuffix: string;
        /** SHA256 cache key for the prefix */
        cacheKey: string;
    };
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

    // ── Runtime Server Proxy ──
    // When running as MCP server (inside a host agent), route ALL engine
    // executions through the runtime HTTP server. This:
    //   1. Avoids nested-engine auth conflicts (copilot-in-copilot)
    //   2. Decouples ACP process lifecycle from the MCP server process
    //   3. Enables runtime server's warm pool, auto-scaling, and retry
    if (shouldRouteViaRuntimeServer()) {
        const serverReady = await ensureRuntimeServer(options.workspacePath);
        // Use heartbeatTimeoutMs as proxy base when it's larger than activityTimeoutMs.
        // heartbeatTimeoutMs (e.g. 600s) is the total wall-clock budget for the task;
        // activityTimeoutMs (e.g. 300s) is only the inactivity window between ACP messages.
        // A multi-step agent task (read files, write code, build) easily exceeds 300s
        // of total elapsed time even if individual ACP messages arrive within 300s —
        // so the proxy must wait at least heartbeatTimeoutMs for the response.
        const heartbeatTimeoutMs = options.workspacePath
            ? (loadEngineHeartbeatTimeout(options.workspacePath, engine) ?? activityTimeoutMs)
            : activityTimeoutMs;
        const effectiveTimeoutMs = Math.max(activityTimeoutMs, heartbeatTimeoutMs);
        const proxyTimeoutMs = resolveRuntimeProxyTimeoutMs(options.timeoutMs, effectiveTimeoutMs);
        if (serverReady) {
            console.error(`[Executor] Routing ${engine} execution via runtime server on :${RUNTIME_PORT}`);
            try {
                return await executeViaRuntimeServer(prompt, options, proxyTimeoutMs);
            } catch (proxyErr: any) {
                // If connection was refused/reset, the runtime server may have crashed.
                // Reset state and try to auto-restart it once.
                if (/ECONNREFUSED|ECONNRESET|EPIPE/.test(proxyErr.message)) {
                    console.error(`[Executor] Runtime server connection lost: ${proxyErr.message}. Attempting auto-restart...`);
                    runtimeServerReady = false;
                    const restarted = await ensureRuntimeServer(options.workspacePath);
                    if (restarted) {
                        console.error(`[Executor] Runtime server restarted, retrying execution`);
                        return await executeViaRuntimeServer(prompt, options, proxyTimeoutMs);
                    }
                }
                throw proxyErr;
            }
        }
        throw new Error(
            `Runtime server not available on port ${RUNTIME_PORT}. ` +
            `Delegate execution requires the runtime server when running inside a host agent. ` +
            `Fix: start the runtime server with: node .optimus/dist/http-runtime.js --port ${RUNTIME_PORT}`
        );
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
            { ...acpOptions, promptParts: options.promptParts }
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
