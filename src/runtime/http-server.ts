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
 * Start:
 *   node dist/http-runtime.js [--port 3100] [--workspace /path/to/project]
 *   OPTIMUS_WORKSPACE_ROOT=/path node dist/http-runtime.js
 *
 * Response format: Always JSON AgentRuntimeEnvelope (or error object).
 * Logs/traces are written to stderr, never mixed into response body.
 */
import http from 'http';
import {
    normalizeRuntimeRequest,
    runSync,
    startRun,
    getRunStatus,
    resumeRun,
    cancelRun,
    RuntimeError
} from './agentRuntimeService';
import dotenv from 'dotenv';
import path from 'path';
import { ensureWorktreeStateDirs } from '../utils/worktree';

declare const OPTIMUS_VERSION: string;

// ─── Config ───

function parseArgs(): { port: number; workspacePath: string } {
    const args = process.argv.slice(2);
    let port = parseInt(process.env.OPTIMUS_RUNTIME_PORT || '3100', 10);
    let workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) {
            port = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--workspace' && args[i + 1]) {
            workspacePath = path.resolve(args[i + 1]);
            i++;
        }
    }

    return { port, workspacePath };
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

function sendError(res: http.ServerResponse, statusCode: number, code: string, message: string): void {
    sendJson(res, statusCode, { error: { code, message } });
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
                    'body_too_large', 413
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
            'empty_body'
        );
    }
    try {
        return JSON.parse(body);
    } catch (e: any) {
        throw new RuntimeError(
            `Invalid JSON in request body: ${e.message || 'parse error'}. Ensure Content-Type is application/json and body is valid JSON.`,
            'invalid_json'
        );
    }
}

/**
 * Classify unhandled errors into specific error codes based on message patterns.
 */
function classifyHttpError(msg: string): { code: string; status: number } {
    if (/auth_failed/i.test(msg) || /authentication required/i.test(msg) || /unauthorized/i.test(msg)) {
        return { code: 'auth_failed', status: 401 };
    }
    if (/rate_limit/i.test(msg) || /429/i.test(msg) || /too many requests/i.test(msg)) {
        return { code: 'rate_limit', status: 429 };
    }
    if (/task_timeout/i.test(msg) || /activity timeout/i.test(msg)) {
        return { code: 'task_timeout', status: 504 };
    }
    if (/acp_process_crashed/i.test(msg) || /exited unexpectedly/i.test(msg)) {
        return { code: 'acp_process_crashed', status: 500 };
    }
    if (/invalid_model/i.test(msg) || /Invalid model/i.test(msg)) {
        return { code: 'invalid_model', status: 400 };
    }
    if (/invalid.*engine/i.test(msg) || /engine.*not.*found/i.test(msg)) {
        return { code: 'invalid_engine', status: 400 };
    }
    if (/\.optimus.*not found/i.test(msg) || /workspace.*not.*initialized/i.test(msg)) {
        return { code: 'workspace_not_initialized', status: 400 };
    }
    return { code: 'internal_error', status: 500 };
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

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, defaultWorkspacePath: string): Promise<void> {
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
            uptime_ms: Math.round(process.uptime() * 1000)
        });
        return;
    }

    // POST /api/v1/agent/run — synchronous run
    if ((params = matchRoute(method, url, '/api/v1/agent/run', 'POST'))) {
        const body = parseJsonBody(await readBody(req));
        if (!body.workspace_path) body.workspace_path = defaultWorkspacePath;
        const request = normalizeRuntimeRequest(body);
        console.error(`[HTTP] POST /agent/run role=${request.role} engine=${request.role_engine || 'default'}`);
        const envelope = await runSync(request);
        sendJson(res, envelope.status === 'completed' ? 200 : 422, envelope);
        return;
    }

    // POST /api/v1/agent/start — async start
    if ((params = matchRoute(method, url, '/api/v1/agent/start', 'POST'))) {
        const body = parseJsonBody(await readBody(req));
        if (!body.workspace_path) body.workspace_path = defaultWorkspacePath;
        const request = normalizeRuntimeRequest(body);
        console.error(`[HTTP] POST /agent/start role=${request.role}`);
        const envelope = startRun(request);
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

    // POST /api/v1/agent/runs/:id/resume
    if ((params = matchRoute(method, url, '/api/v1/agent/runs/:id/resume', 'POST'))) {
        const body = parseJsonBody(await readBody(req));
        const workspacePath = body.workspace_path || defaultWorkspacePath;
        if (!body.human_answer) {
            throw new RuntimeError('Missing required field: human_answer', 'missing_params');
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

    // 404
    sendError(res, 404, 'not_found', `Route not found: ${method} ${url}`);
}

// ─── Server ───

function startServer() {
    const { port, workspacePath } = parseArgs();

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
            await handleRequest(req, res, workspacePath);
        } catch (err: any) {
            if (err instanceof RuntimeError) {
                sendError(res, err.httpStatus, err.code, err.message);
            } else {
                const msg = err.message || 'Internal server error';
                console.error(`[HTTP] Unhandled error: ${msg}`);
                // Classify common engine errors into actionable codes
                const { code, status } = classifyHttpError(msg);
                sendError(res, status, code, msg);
            }
        }
    });

    server.listen(port, () => {
        console.error(`\n🚀 Optimus Agent Runtime — HTTP Server`);
        console.error(`   Port:      ${port}`);
        console.error(`   Workspace: ${workspacePath}`);
        console.error(`   Endpoints:`);
        console.error(`     POST /api/v1/agent/run             — Sync run`);
        console.error(`     POST /api/v1/agent/start           — Async start`);
        console.error(`     GET  /api/v1/agent/runs/:id        — Get status`);
        console.error(`     POST /api/v1/agent/runs/:id/resume — Resume`);
        console.error(`     POST /api/v1/agent/runs/:id/cancel — Cancel`);
        console.error(`     GET  /api/v1/health                — Health\n`);
    });

    process.on('SIGTERM', () => { server.close(); process.exit(0); });
    process.on('SIGINT', () => { server.close(); process.exit(0); });
}

startServer();
