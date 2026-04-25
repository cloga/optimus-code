/**
 * Generic Agent Runtime — stateless, decoupled from Optimus orchestration.
 *
 * Provides run tracking, status management, and envelope building
 * without depending on TaskManifestManager, role templates, or .optimus/ layout.
 */
import crypto from 'crypto';
import { executePrompt, ExecuteResult, ExecuteOptions, getBuiltinEngines } from './genericExecutor';
import { getConfiguredEngineNames } from '../mcp/engine-resolver';
import { resolveWorkspaceRoot } from '../utils/worktree';

// ─── Types ───

export type GenericRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface GenericRunRequest {
    prompt: string;
    engine?: string;
    model?: string;
    output_schema?: unknown;
    timeout_ms?: number;
    session_id?: string;
    workspace_path?: string;
}

export interface GenericRunEnvelope {
    run_id: string;
    status: GenericRunStatus;
    result?: unknown;
    error?: {
        code: string;
        message: string;
    };
    metadata: {
        engine?: string;
        model?: string;
        session_id?: string;
        workspace_path?: string;
        duration_ms?: number;
        usage?: Record<string, unknown>;
        stop_reason?: string;
        created_at: string;
        updated_at: string;
    };
}

export interface GenericEngineDiagnostics {
    engines: string[];
    builtin_engines: string[];
    configured_engines: string[];
    workspace_path?: string;
}

export interface GenericHealthPayload {
    status: 'ok';
    version: string;
    engines: string[];
    builtin_engines: string[];
    configured_engines: string[];
    workspace: string;
    uptime_ms: number;
}

// ─── In-Memory Run Store ───

interface RunRecord {
    runId: string;
    request: GenericRunRequest;
    status: GenericRunStatus;
    result?: ExecuteResult;
    error?: { code: string; message: string };
    createdAt: string;
    updatedAt: string;
}

const runStore = new Map<string, RunRecord>();

function generateRunId(): string {
    return `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function buildEnvelope(record: RunRecord): GenericRunEnvelope {
    const r = record.result;
    return {
        run_id: record.runId,
        status: record.status,
        ...(record.status === 'completed' && r
            ? { result: r.parsed !== undefined ? r.parsed : r.output }
            : {}),
        ...(record.error ? { error: record.error } : {}),
        metadata: {
            engine: record.request.engine,
            model: record.request.model,
            session_id: r?.sessionId,
            workspace_path: record.request.workspace_path,
            duration_ms: r?.durationMs,
            usage: r?.usage,
            stop_reason: r?.stopReason,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
        },
    };
}

// ─── Public API ───

/**
 * Synchronous run: execute prompt and return result.
 */
export async function runGenericSync(request: GenericRunRequest): Promise<GenericRunEnvelope> {
    validateRequest(request);
    request = normalizeRequest(request);
    const runId = generateRunId();
    const now = new Date().toISOString();

    const record: RunRecord = {
        runId,
        request,
        status: 'running',
        createdAt: now,
        updatedAt: now,
    };
    runStore.set(runId, record);

    try {
        const result = await executePrompt(request.prompt, toExecuteOptions(request));

        record.status = result.parseError ? 'failed' : 'completed';
        record.result = result;
        if (result.parseError) {
            record.error = { code: 'invalid_structured_output', message: result.parseError };
        }
        record.updatedAt = new Date().toISOString();
        return buildEnvelope(record);
    } catch (err: any) {
        record.status = 'failed';
        record.error = { code: 'execution_failed', message: err.message || String(err) };
        record.updatedAt = new Date().toISOString();
        return buildEnvelope(record);
    }
}

/**
 * Async start: return immediately, execute in background.
 */
export function startGenericRun(request: GenericRunRequest): GenericRunEnvelope {
    validateRequest(request);
    request = normalizeRequest(request);
    const runId = generateRunId();
    const now = new Date().toISOString();

    const record: RunRecord = {
        runId,
        request,
        status: 'running',
        createdAt: now,
        updatedAt: now,
    };
    runStore.set(runId, record);

    // Fire and forget on the next tick. Calling an async function directly still
    // runs its pre-await setup synchronously, which can block /agent/start.
    setImmediate(() => {
        executePrompt(request.prompt, toExecuteOptions(request))
            .then(result => {
                record.status = result.parseError ? 'failed' : 'completed';
                record.result = result;
                if (result.parseError) {
                    record.error = { code: 'invalid_structured_output', message: result.parseError };
                }
                record.updatedAt = new Date().toISOString();
            })
            .catch(err => {
                record.status = 'failed';
                record.error = { code: 'execution_failed', message: err.message || String(err) };
                record.updatedAt = new Date().toISOString();
            });
    });

    return buildEnvelope(record);
}

/**
 * Get run status.
 */
export function getGenericRunStatus(runId: string, workspacePath?: string): GenericRunEnvelope {
    const record = runStore.get(runId);
    if (!record) {
        throw Object.assign(
            new Error(`Run '${runId}' not found. Fix: verify the run_id is correct.`),
            { statusCode: 404 }
        );
    }
    assertWorkspaceMatch(record, workspacePath);
    return buildEnvelope(record);
}

/**
 * Cancel a running run (best-effort).
 */
export function cancelGenericRun(runId: string, workspacePath?: string): GenericRunEnvelope {
    const record = runStore.get(runId);
    if (!record) {
        throw Object.assign(
            new Error(`Run '${runId}' not found. Fix: verify the run_id is correct.`),
            { statusCode: 404 }
        );
    }
    assertWorkspaceMatch(record, workspacePath);
    if (record.status === 'running') {
        record.status = 'cancelled';
        record.error = { code: 'cancelled', message: 'Run was cancelled by user.' };
        record.updatedAt = new Date().toISOString();
    }
    return buildEnvelope(record);
}

/**
 * List available engines for the generic runtime.
 */
export function listGenericEngines(workspacePath?: string): string[] {
    return getGenericEngineDiagnostics(workspacePath).engines;
}

/**
 * Build runtime diagnostics that distinguish built-in generic engines from
 * workspace-configured engines resolved through available-agents.json.
 */
export function getGenericEngineDiagnostics(workspacePath?: string): GenericEngineDiagnostics {
    const builtinEngines = getBuiltinEngines();
    const resolvedWorkspace = resolveWorkspaceRoot(workspacePath);
    const configuredEngines = resolvedWorkspace ? getConfiguredEngineNames(resolvedWorkspace) : [];
    const engines = Array.from(new Set([...builtinEngines, ...configuredEngines]));
    return {
        engines,
        builtin_engines: builtinEngines,
        configured_engines: configuredEngines,
        ...(resolvedWorkspace ? { workspace_path: resolvedWorkspace } : {}),
    };
}

export function buildGenericHealthPayload(version: string, uptimeMs: number, workspacePath?: string): GenericHealthPayload {
    const engineDiagnostics = getGenericEngineDiagnostics(workspacePath);
    return {
        status: 'ok',
        version,
        engines: engineDiagnostics.engines,
        builtin_engines: engineDiagnostics.builtin_engines,
        configured_engines: engineDiagnostics.configured_engines,
        workspace: engineDiagnostics.workspace_path || '',
        uptime_ms: uptimeMs,
    };
}

// ─── Helpers ───

function validateRequest(request: GenericRunRequest): void {
    if (!request.prompt || typeof request.prompt !== 'string' || !request.prompt.trim()) {
        throw Object.assign(
            new Error(`'prompt' is required and must be a non-empty string.`),
            { statusCode: 400 }
        );
    }
    if (request.timeout_ms !== undefined) {
        if (typeof request.timeout_ms !== 'number' || request.timeout_ms <= 0 || request.timeout_ms > 1_800_000) {
            throw Object.assign(
                new Error(`timeout_ms must be between 1 and 1800000 (30 minutes). Got: ${request.timeout_ms}`),
                { statusCode: 400 }
            );
        }
    }
}

function normalizeRequest(request: GenericRunRequest): GenericRunRequest {
    const workspacePath = resolveWorkspaceRoot(request.workspace_path);
    return {
        ...request,
        workspace_path: workspacePath,
    };
}

function assertWorkspaceMatch(record: RunRecord, workspacePath?: string): void {
    const requestedWorkspace = resolveWorkspaceRoot(workspacePath);
    if (!requestedWorkspace) return;
    if (record.request.workspace_path !== requestedWorkspace) {
        throw Object.assign(
            new Error(`Run '${record.runId}' not found in workspace '${requestedWorkspace}'. Fix: use the workspace that started the run.`),
            { statusCode: 404 }
        );
    }
}

function toExecuteOptions(request: GenericRunRequest): ExecuteOptions {
    const workspacePath = request.workspace_path || resolveWorkspaceRoot(process.env.OPTIMUS_WORKSPACE_ROOT);
    if (!workspacePath) {
        console.error('[GenericRuntime] ⚠️ No workspace_path in request and OPTIMUS_WORKSPACE_ROOT not set. Custom engines from available-agents.json will not be available. Fix: include workspace_path in the request body or set OPTIMUS_WORKSPACE_ROOT env var.');
    }
    return {
        engine: request.engine,
        model: request.model,
        sessionId: request.session_id,
        outputSchema: request.output_schema,
        timeoutMs: request.timeout_ms,
        workspacePath,
    };
}
