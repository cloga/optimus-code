#!/usr/bin/env node
/**
 * Optimus Agent Runtime — HTTP Server
 *
 * A transport-agnostic REST API for the Agent Runtime, enabling host applications
 * to consume Optimus without speaking MCP transport directly.
 *
 * Endpoints:
 *   POST /api/v1/agent/run             — Sync run (blocks until complete)
 *   POST /api/v1/agent/start           — Async start (returns immediately)
 *   GET  /api/v1/agent/runs/:id        — Get run status/result
 *   POST /api/v1/agent/runs/:id/resume — Resume blocked run
 *   POST /api/v1/agent/runs/:id/cancel — Cancel active run
 *   GET  /api/v1/health                — Health check
 *
 * Auto-scaling: when at capacity, spawns overflow instances on adjacent ports.
 * Overflow instances auto-shutdown after idle timeout (default: 60s).
 *
 * Start:
 *   node dist/http-runtime.js [--port 3100] [--workspace /path/to/project]
 *   OPTIMUS_WORKSPACE_ROOT=/path node dist/http-runtime.js
 *
 * Response format: Always JSON AgentRuntimeEnvelope (or error object).
 * Logs/traces are written to stderr, never mixed into response body.
 */
import http from 'http';
import { spawn, ChildProcess } from 'child_process';
import {
    normalizeRuntimeRequest,
    runSync,
    startRun,
    getRunStatus,
    resumeRun,
    cancelRun,
    RuntimeError
} from './agentRuntimeService';
import {
    runGenericSync,
    startGenericRun,
    getGenericRunStatus,
    cancelGenericRun,
    listGenericEngines,
} from './genericRuntime';
import { subscribeToEvents, getEventBuffer } from '../utils/agentRuntime';
import dotenv from 'dotenv';
import path from 'path';
import { ensureWorktreeStateDirs } from '../utils/worktree';

declare const OPTIMUS_VERSION: string;

// ─── Config ───

interface ParsedArgs {
    port: number;
    workspacePath: string;
    isOverflow: boolean;
    idleTimeoutMs: number;
}

function parseArgs(): ParsedArgs {
    const args = process.argv.slice(2);
    let port = parseInt(process.env.OPTIMUS_RUNTIME_PORT || '3100', 10);
    let workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    let isOverflow = false;
    let idleTimeoutMs = 60_000;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) {
            port = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--workspace' && args[i + 1]) {
            workspacePath = path.resolve(args[i + 1]);
            i++;
        } else if (args[i] === '--overflow') {
            isOverflow = true;
        } else if (args[i] === '--idle-timeout' && args[i + 1]) {
            idleTimeoutMs = parseInt(args[i + 1], 10) * 1000;
            i++;
        }
    }

    return { port, workspacePath, isOverflow, idleTimeoutMs };
}

// ─── HTTP Helpers ───

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const json = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
        'Access-Control-Allow-Origin': '*',
    });
    res.end(json);
}

function sendError(res: http.ServerResponse, statusCode: number, code: string, message: string, fix?: string): void {
    const error: Record<string, string> = { code, message };
    if (fix) error.fix = fix;
    sendJson(res, statusCode, { error });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        const maxSize = 10 * 1024 * 1024; // 10MB

        req.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > maxSize) {
                reject(new RuntimeError(
                    'Request body too large (limit: 10 MB). Reduce input size or use context_files references instead of inline content.',
                    'body_too_large', 413,
                    'Reduce the request body size to under 10 MB. Move large content to files and reference them via context_files: [{ path: "file.txt" }] instead of inline.'
                ));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function parseJsonBody(body: string): any {
    if (!body.trim()) {
        throw new RuntimeError(
            'Request body is empty. Send a JSON object with required fields: role, workspace_path, input.',
            'empty_body',
            400,
            'Send a JSON POST body: { "role": "<role-name>", "workspace_path": "<path>", "input": "<task>" }. Set Content-Type: application/json.'
        );
    }
    try {
        return JSON.parse(body);
    } catch (e: any) {
        throw new RuntimeError(
            `Invalid JSON in request body: ${e.message || 'parse error'}. Ensure Content-Type is application/json and body is valid JSON.`,
            'invalid_json',
            400,
            'Verify the request body is valid JSON. Use a JSON validator or check for trailing commas, unquoted keys, or encoding issues.'
        );
    }
}

/**
 * Classify unhandled errors into actionable error responses.
 * Each category includes a machine-readable `fix` with concrete recovery steps.
 */
function classifyHttpError(msg: string): { code: string; status: number; fix: string } {
    if (/auth_failed/i.test(msg) || /authentication required/i.test(msg) || /unauthorized/i.test(msg)) {
        return {
            code: 'auth_failed', status: 401,
            fix: 'For Copilot: run `gh auth login` (copilot uses gh CLI auth, not env vars). For Claude: run `claude login` or set ANTHROPIC_API_KEY. Note: .env GITHUB_TOKEN is for Optimus GitHub API operations, not engine auth.'
        };
    }
    if (/rate_limit/i.test(msg) || /429/i.test(msg) || /too many requests/i.test(msg)) {
        return {
            code: 'rate_limit', status: 429,
            fix: 'Retry after a brief delay. Add `runtime_policy: { retries: 2 }` to your request for automatic retry with backoff.'
        };
    }
    if (/task_timeout/i.test(msg) || /activity timeout/i.test(msg)) {
        return {
            code: 'task_timeout', status: 504,
            fix: 'The engine produced no output within the timeout window. Increase via `runtime_policy: { timeout_ms: 300000 }` in your request, or set `timeout.activity_ms` in .optimus/config/available-agents.json for the engine.'
        };
    }
    if (/acp_process_crashed/i.test(msg) || /exited unexpectedly/i.test(msg)) {
        return {
            code: 'acp_process_crashed', status: 500,
            fix: 'The engine process exited unexpectedly. The warm pool auto-recovers — retry the same request. If persistent, check engine installation (`copilot --version` or `claude --version`).'
        };
    }
    if (/invalid_model/i.test(msg) || /Invalid model/i.test(msg)) {
        return {
            code: 'invalid_model', status: 400,
            fix: 'The specified role_model is not available for this engine. Remove role_model to use the default, or check valid models in .optimus/config/available-agents.json.'
        };
    }
    if (/invalid.*engine/i.test(msg) || /engine.*not.*found/i.test(msg)) {
        return {
            code: 'invalid_engine', status: 400,
            fix: 'The specified role_engine is not configured. Remove role_engine to use the default, or check .optimus/config/available-agents.json for valid engine names.'
        };
    }
    if (/\.optimus.*not found/i.test(msg) || /workspace.*not.*initialized/i.test(msg)) {
        return {
            code: 'workspace_not_initialized', status: 400,
            fix: 'The workspace has no .optimus/ directory. Run `npx github:cloga/optimus-code upgrade` in your project root to initialize it.'
        };
    }
    if (/quarantine/i.test(msg)) {
        return {
            code: 'role_quarantined', status: 400,
            fix: 'This role was quarantined after consecutive failures. Fix the role template at .optimus/roles/<role>.md, delete it to allow re-creation, or use the quarantine_role tool to unquarantine.'
        };
    }
    if (/skill.*pre-?flight/i.test(msg) || /missing.*required.*skill/i.test(msg)) {
        return {
            code: 'skill_preflight_failed', status: 400,
            fix: 'Required skill(s) not found in .optimus/skills/. Create the missing skill directory with a SKILL.md file, or remove the skill requirement from the request.'
        };
    }
    if (/engine.*resolution.*failed/i.test(msg) || /unable to resolve.*engine/i.test(msg)) {
        return {
            code: 'engine_resolution_failed', status: 400,
            fix: 'No engine could be resolved for this role. Specify role_engine explicitly (e.g. "github-copilot" or "claude-code"), or add a default engine in .optimus/config/available-agents.json.'
        };
    }
    if (/CAPIError/i.test(msg)) {
        const statusMatch = msg.match(/CAPIError:\s*(\d{3})/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 502;
        return {
            code: `capi_error_${statusMatch?.[1] || 'unknown'}`, status,
            fix: 'Copilot backend API returned an error. Verify: (1) model name is supported by Copilot (`gpt-5.4`, `claude-sonnet-4`), (2) `gh auth login` is current, (3) your Copilot subscription is active. Retry with a different model if the issue persists.'
        };
    }
    if (/Invalid automation policy/i.test(msg)) {
        return {
            code: 'automation_policy_invalid', status: 422,
            fix: 'Engine automation policy mismatch. Run `npx github:cloga/optimus-code upgrade` to refresh config with system defaults. System defaults inject ACP + autopilot capabilities automatically.'
        };
    }
    return {
        code: 'internal_error', status: 500,
        fix: 'An unexpected error occurred. Check the runtime stderr logs for details. If the error persists, retry the request or restart the runtime process.'
    };
}

// ─── Route matching ───

type RouteParams = Record<string, string>;

function matchRoute(method: string, url: string, pattern: string, expectedMethod: string): RouteParams | null {
    if (method !== expectedMethod) return null;

    const urlParts = url.split('/').filter(Boolean);
    const patternParts = pattern.split('/').filter(Boolean);

    if (urlParts.length !== patternParts.length) return null;

    const params: RouteParams = {};
    for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
            params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
        } else if (patternParts[i] !== urlParts[i]) {
            return null;
        }
    }
    return params;
}

// ─── Request handler ───

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, defaultWorkspacePath: string, basePort: number): Promise<void> {
    const url = (req.url || '/').split('?')[0];
    const method = (req.method || 'GET').toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Optimus-Mode',
            'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
    }

    let params: RouteParams | null;

    // GET /api/v1/health
    if ((params = matchRoute(method, url, '/api/v1/health', 'GET'))) {
        sendJson(res, 200, {
            status: 'ok',
            version: typeof OPTIMUS_VERSION !== 'undefined' ? OPTIMUS_VERSION : 'dev',
            workspace: defaultWorkspacePath,
            uptime_ms: Math.round(process.uptime() * 1000),
            active_runs: activeRuns,
            max_concurrent: MAX_CONCURRENT_RUNS,
            overflow: {
                instances: overflowPool.map(inst => ({
                    port: inst.port,
                    active_runs: inst.activeRuns,
                    ready: inst.ready,
                    idle_ms: Date.now() - inst.lastActivity
                })),
                max_instances: MAX_OVERFLOW_INSTANCES,
                total_capacity: MAX_CONCURRENT_RUNS * (1 + MAX_OVERFLOW_INSTANCES)
            }
        });
        return;
    }

    // POST /api/v1/agent/run — synchronous run
    if ((params = matchRoute(method, url, '/api/v1/agent/run', 'POST'))) {
        const body = parseJsonBody(await readBody(req));
        if (activeRuns >= MAX_CONCURRENT_RUNS) {
            // Try overflow auto-scaling before rejecting
            const rawBody = JSON.stringify(body);
            if (await tryOverflow(basePort, defaultWorkspacePath, req, res, rawBody)) {
                return; // proxied to overflow instance
            }
            const totalCapacity = MAX_CONCURRENT_RUNS * (1 + overflowPool.length);
            sendError(res, 429, 'concurrency_limit',
                `All instances at capacity (${activeRuns + overflowPool.reduce((s, i) => s + i.activeRuns, 0)}/${totalCapacity} total concurrent runs across ${1 + overflowPool.length} instances).`,
                `All ${1 + overflowPool.length} instances (max overflow: ${MAX_OVERFLOW_INSTANCES}) are full. Wait for a run to complete, or increase limits with OPTIMUS_MAX_CONCURRENT (per-instance) and OPTIMUS_MAX_OVERFLOW (overflow instances).`
            );
            return;
        }
        if (!body.workspace_path) body.workspace_path = defaultWorkspacePath;
        const request = normalizeRuntimeRequest(body);
        console.error(`[HTTP] POST /agent/run role=${request.role} engine=${request.role_engine || 'default'} (active: ${activeRuns + 1}/${MAX_CONCURRENT_RUNS})`);
        activeRuns++;
        lastActivity = Date.now();
        try {
            const envelope = await runSync(request);
            sendJson(res, envelope.status === 'completed' ? 200 : 422, envelope);
        } finally {
            activeRuns--;
            lastActivity = Date.now();
        }
        return;
    }

    // POST /api/v1/agent/start — async start
    if ((params = matchRoute(method, url, '/api/v1/agent/start', 'POST'))) {
        const body = parseJsonBody(await readBody(req));
        if (activeRuns >= MAX_CONCURRENT_RUNS) {
            const rawBody = JSON.stringify(body);
            if (await tryOverflow(basePort, defaultWorkspacePath, req, res, rawBody)) {
                return;
            }
            const totalCapacity = MAX_CONCURRENT_RUNS * (1 + overflowPool.length);
            sendError(res, 429, 'concurrency_limit',
                `All instances at capacity (${activeRuns + overflowPool.reduce((s, i) => s + i.activeRuns, 0)}/${totalCapacity} total concurrent runs).`,
                `All instances are full. Wait for a run to complete, or increase limits with OPTIMUS_MAX_CONCURRENT and OPTIMUS_MAX_OVERFLOW.`
            );
            return;
        }
        if (!body.workspace_path) body.workspace_path = defaultWorkspacePath;
        const request = normalizeRuntimeRequest(body);
        console.error(`[HTTP] POST /agent/start role=${request.role} (active: ${activeRuns + 1}/${MAX_CONCURRENT_RUNS})`);
        activeRuns++;
        lastActivity = Date.now();
        const envelope = startRun(request);
        // Track when async run completes to release the slot
        const runId = envelope.run_id;
        if (runId) {
            const checkCompletion = setInterval(() => {
                try {
                    const status = getRunStatus(request.workspace_path, runId);
                    const terminal = ['completed', 'failed', 'cancelled', 'verified', 'partial', 'degraded'];
                    if (terminal.includes(status.status)) {
                        activeRuns--;
                        lastActivity = Date.now();
                        clearInterval(checkCompletion);
                    }
                } catch {
                    activeRuns--;
                    lastActivity = Date.now();
                    clearInterval(checkCompletion);
                }
            }, 5000);
        }
        sendJson(res, 202, envelope);
        return;
    }

    // GET /api/v1/agent/runs/:id
    if ((params = matchRoute(method, url, '/api/v1/agent/runs/:id', 'GET'))) {
        const workspacePath = (req.headers['x-optimus-workspace'] as string) || defaultWorkspacePath;
        console.error(`[HTTP] GET /agent/runs/${params.id}`);
        const envelope = getRunStatus(workspacePath, params.id);
        sendJson(res, 200, envelope);
        return;
    }

    // GET /api/v1/agent/runs/:id/stream — SSE streaming endpoint
    if ((params = matchRoute(method, url, '/api/v1/agent/runs/:id/stream', 'GET'))) {
        const runId = params.id;
        const urlObj = new URL(`http://localhost${req.url}`);
        const since = parseInt(urlObj.searchParams.get('since') || '0', 10);
        console.error(`[HTTP] GET /agent/runs/${runId}/stream (SSE, since=${since})`);

        const buffer = getEventBuffer(runId);
        if (!buffer) {
            sendError(res, 404, 'stream_not_found',
                `No streaming buffer for run '${runId}'. The run may have already completed or the run ID is invalid.`,
                'Start a run with POST /api/v1/agent/start first, then connect to /stream before the run finishes. Alternatively, use GET /api/v1/agent/runs/:id to poll for the final result.'
            );
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Optimus-Instance': `primary:${basePort}`,
        });

        const { unsubscribe, completed: alreadyDone } = subscribeToEvents(runId, since, (event) => {
            try {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            } catch { /* client may have disconnected */ }
        });

        const heartbeat = setInterval(() => {
            try { res.write(': heartbeat\n\n'); } catch { /* ignore */ }
        }, 15000);

        if (alreadyDone) {
            clearInterval(heartbeat);
            unsubscribe();
            res.end();
            return;
        }

        const checkDone = setInterval(() => {
            const currentBuffer = getEventBuffer(runId);
            if (!currentBuffer || currentBuffer.completed) {
                clearInterval(checkDone);
                clearInterval(heartbeat);
                unsubscribe();
                try { res.end(); } catch { /* ignore */ }
            }
        }, 1000);

        req.on('close', () => {
            clearInterval(checkDone);
            clearInterval(heartbeat);
            unsubscribe();
        });

        return;
    }

    // POST /api/v1/agent/runs/:id/resume
    if ((params = matchRoute(method, url, '/api/v1/agent/runs/:id/resume', 'POST'))) {
        const body = parseJsonBody(await readBody(req));
        const workspacePath = body.workspace_path || defaultWorkspacePath;
        if (!body.human_answer) {
            throw new RuntimeError('Missing required field: human_answer', 'missing_params', 400,
                'Include human_answer in the JSON body: { "human_answer": "<your-response>" }. This is the answer to the question the agent asked during the run.'
            );
        }
        console.error(`[HTTP] POST /agent/runs/${params.id}/resume`);
        const envelope = resumeRun(workspacePath, params.id, body.human_answer);
        sendJson(res, 200, envelope);
        return;
    }

    // POST /api/v1/agent/runs/:id/cancel
    if ((params = matchRoute(method, url, '/api/v1/agent/runs/:id/cancel', 'POST'))) {
        const body = await readBody(req);
        const parsed = body.trim() ? JSON.parse(body) : {};
        const workspacePath = parsed.workspace_path || defaultWorkspacePath;
        console.error(`[HTTP] POST /agent/runs/${params.id}/cancel`);
        const envelope = await cancelRun(workspacePath, params.id, parsed.reason);
        sendJson(res, 200, envelope);
        return;
    }

    // ─── v2 Generic API (no Optimus orchestration) ───

    // GET /api/v2/health
    if ((params = matchRoute(method, url, '/api/v2/health', 'GET'))) {
        sendJson(res, 200, {
            status: 'ok',
            version: typeof OPTIMUS_VERSION !== 'undefined' ? OPTIMUS_VERSION : 'dev',
            engines: listGenericEngines(),
            uptime_ms: Math.round(process.uptime() * 1000),
        });
        return;
    }

    // POST /api/v2/agent/run — synchronous generic run
    if ((params = matchRoute(method, url, '/api/v2/agent/run', 'POST'))) {
        const parsed = parseJsonBody(await readBody(req));
        console.error(`[HTTP] POST /api/v2/agent/run engine=${parsed.engine || 'default'}`);
        const envelope = await runGenericSync(parsed);
        sendJson(res, envelope.status === 'completed' ? 200 : 422, envelope);
        return;
    }

    // POST /api/v2/agent/start — async generic start
    if ((params = matchRoute(method, url, '/api/v2/agent/start', 'POST'))) {
        const parsed = parseJsonBody(await readBody(req));
        console.error(`[HTTP] POST /api/v2/agent/start engine=${parsed.engine || 'default'}`);
        const envelope = startGenericRun(parsed);
        sendJson(res, 202, envelope);
        return;
    }

    // GET /api/v2/agent/runs/:id — generic status
    if ((params = matchRoute(method, url, '/api/v2/agent/runs/:id', 'GET'))) {
        const envelope = getGenericRunStatus(params.id!);
        sendJson(res, 200, envelope);
        return;
    }

    // POST /api/v2/agent/runs/:id/cancel — cancel generic run
    if ((params = matchRoute(method, url, '/api/v2/agent/runs/:id/cancel', 'POST'))) {
        const envelope = cancelGenericRun(params.id!);
        sendJson(res, 200, envelope);
        return;
    }

    // 404
    sendError(res, 404, 'not_found', `Route not found: ${method} ${url}`,
        'Valid endpoints: POST /api/v1/agent/run, POST /api/v1/agent/start, GET /api/v1/agent/runs/:id, POST /api/v1/agent/runs/:id/resume, POST /api/v1/agent/runs/:id/cancel, GET /api/v1/health, POST /api/v2/agent/run, POST /api/v2/agent/start, GET /api/v2/agent/runs/:id, POST /api/v2/agent/runs/:id/cancel, GET /api/v2/health'
    );
}

// ─── Overflow Auto-Scaling Pool ───

interface OverflowInstance {
    port: number;
    process: ChildProcess;
    activeRuns: number;
    lastActivity: number;
    ready: boolean;
}

const MAX_OVERFLOW_INSTANCES = parseInt(process.env.OPTIMUS_MAX_OVERFLOW || '3', 10);
const OVERFLOW_IDLE_TIMEOUT_S = parseInt(process.env.OPTIMUS_OVERFLOW_IDLE_TIMEOUT || '60', 10);
const overflowPool: OverflowInstance[] = [];

function findAvailableOverflow(): OverflowInstance | undefined {
    return overflowPool.find(inst => inst.ready && inst.activeRuns < MAX_CONCURRENT_RUNS);
}

function spawnOverflowInstance(basePort: number, workspacePath: string): OverflowInstance | null {
    if (overflowPool.length >= MAX_OVERFLOW_INSTANCES) {
        return null;
    }

    // Find next available port
    const usedPorts = new Set([basePort, ...overflowPool.map(i => i.port)]);
    let overflowPort = basePort + 1;
    while (usedPorts.has(overflowPort)) overflowPort++;

    const scriptPath = process.argv[1]; // path to http-runtime.js
    const child = spawn(process.execPath, [
        scriptPath,
        '--port', String(overflowPort),
        '--workspace', workspacePath,
        '--overflow',
        '--idle-timeout', String(OVERFLOW_IDLE_TIMEOUT_S)
    ], {
        stdio: ['ignore', 'ignore', 'pipe'], // capture stderr for logs
        env: { ...process.env }
    });

    const instance: OverflowInstance = {
        port: overflowPort,
        process: child,
        activeRuns: 0,
        lastActivity: Date.now(),
        ready: false
    };

    // Detect when overflow is ready
    child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        if (line.includes('Optimus Agent Runtime')) {
            instance.ready = true;
        }
        // Forward logs with prefix
        process.stderr.write(`[overflow:${overflowPort}] ${line}`);
    });

    child.on('exit', (code) => {
        const idx = overflowPool.indexOf(instance);
        if (idx >= 0) overflowPool.splice(idx, 1);
        console.error(`[Autoscale] Overflow instance :${overflowPort} exited (code=${code}). Pool: ${overflowPool.length} instances`);
    });

    overflowPool.push(instance);
    console.error(`[Autoscale] 🚀 Spawned overflow instance :${overflowPort} (pool: ${overflowPool.length}/${MAX_OVERFLOW_INSTANCES})`);
    return instance;
}

/**
 * Proxy an HTTP request to an overflow instance.
 */
function proxyToOverflow(instance: OverflowInstance, req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    instance.activeRuns++;
    instance.lastActivity = Date.now();

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: instance.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${instance.port}` },
        timeout: 0 // no timeout for long-running agent tasks
    }, (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
            instance.activeRuns--;
            instance.lastActivity = Date.now();
            res.writeHead(proxyRes.statusCode || 200, {
                ...proxyRes.headers,
                'X-Optimus-Instance': `overflow:${instance.port}`
            });
            res.end(Buffer.concat(chunks));
        });
    });

    proxyReq.on('error', (err) => {
        instance.activeRuns--;
        sendError(res, 502, 'overflow_proxy_error',
            `Overflow instance :${instance.port} is unreachable: ${err.message}`,
            'The overflow instance may have crashed. Retry the request — a new instance will be spawned if needed.'
        );
    });

    proxyReq.write(body);
    proxyReq.end();
}

/**
 * Try to handle overflow: find or spawn an overflow instance and proxy to it.
 * Returns true if proxied, false if no capacity.
 */
async function tryOverflow(basePort: number, workspacePath: string, req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<boolean> {
    // Try existing overflow instances first
    let instance: OverflowInstance | null | undefined = findAvailableOverflow();
    if (!instance) {
        // Spawn a new one
        instance = spawnOverflowInstance(basePort, workspacePath);
        if (!instance) {
            return false; // max overflow reached
        }
        // Wait for it to become ready (up to 5s)
        for (let i = 0; i < 50 && !instance.ready; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (!instance.ready) {
            return false;
        }
    }

    console.error(`[Autoscale] ➡️  Routing to overflow :${instance.port} (active: ${instance.activeRuns + 1}/${MAX_CONCURRENT_RUNS})`);
    proxyToOverflow(instance, req, res, body);
    return true;
}

// ─── Server ───

const MAX_CONCURRENT_RUNS = parseInt(process.env.OPTIMUS_MAX_CONCURRENT || '5', 10);
let activeRuns = 0;

function startServer() {
    const { port, workspacePath, isOverflow, idleTimeoutMs } = parseArgs();

    // Load .env
    if (process.env.DOTENV_PATH) {
        dotenv.config({ path: path.resolve(process.env.DOTENV_PATH), override: true });
    } else {
        dotenv.config({ override: true });
    }

    // Ensure state directories exist
    ensureWorktreeStateDirs(workspacePath);

    const server = http.createServer(async (req, res) => {
        try {
            await handleRequest(req, res, workspacePath, port);
        } catch (err: any) {
            if (err instanceof RuntimeError) {
                sendError(res, err.httpStatus, err.code, err.message, err.fix);
            } else if (err.statusCode) {
                // Generic runtime errors with explicit status codes
                sendError(res, err.statusCode, 'validation_error', err.message);
            } else {
                const msg = err.message || 'Internal server error';
                console.error(`[HTTP] Unhandled error: ${msg}`);
                const { code, status, fix } = classifyHttpError(msg);
                sendError(res, status, code, msg, fix);
            }
        }
    });

    // Agent tasks are long-running (minutes to tens of minutes).
    // Disable Node.js default timeouts that would kill connections prematurely.
    server.timeout = 0;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 620_000;

    server.listen(port, () => {
        const label = isOverflow ? '(overflow)' : '(primary)';
        console.error(`\n🚀 Optimus Agent Runtime — HTTP Server ${label}`);
        console.error(`   Port:      ${port}`);
        console.error(`   Workspace: ${workspacePath}`);
        console.error(`   Max concurrent: ${MAX_CONCURRENT_RUNS}`);
        if (!isOverflow) {
            console.error(`   Max overflow:   ${MAX_OVERFLOW_INSTANCES} (total capacity: ${MAX_CONCURRENT_RUNS * (1 + MAX_OVERFLOW_INSTANCES)})`);
        }
        console.error(`   Endpoints:`);
        console.error(`     POST /api/v1/agent/run             — Sync run`);
        console.error(`     POST /api/v1/agent/start           — Async start`);
        console.error(`     GET  /api/v1/agent/runs/:id        — Get status`);
        console.error(`     POST /api/v1/agent/runs/:id/resume — Resume`);
        console.error(`     POST /api/v1/agent/runs/:id/cancel — Cancel`);
        console.error(`     GET  /api/v1/health                — Health`);
        console.error(`   Generic API (v2):`);
        console.error(`     POST /api/v2/agent/run             — Sync run (prompt-based)`);
        console.error(`     POST /api/v2/agent/start           — Async start`);
        console.error(`     GET  /api/v2/agent/runs/:id        — Get status`);
        console.error(`     POST /api/v2/agent/runs/:id/cancel — Cancel`);
        console.error(`     GET  /api/v2/health                — Health & engines\n`);
    });

    // Overflow instances auto-shutdown when idle
    if (isOverflow) {
        const idleCheck = setInterval(() => {
            if (activeRuns === 0 && (Date.now() - lastActivity) > idleTimeoutMs) {
                console.error(`[Overflow] Idle for ${Math.round(idleTimeoutMs / 1000)}s with no active runs. Shutting down.`);
                clearInterval(idleCheck);
                server.close(() => process.exit(0));
            }
        }, 5000);
    }

    process.on('SIGTERM', () => {
        // Gracefully shutdown overflow instances
        overflowPool.forEach(inst => inst.process.kill('SIGTERM'));
        server.close();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        overflowPool.forEach(inst => inst.process.kill('SIGTERM'));
        server.close();
        process.exit(0);
    });
}

let lastActivity = Date.now();

startServer();
