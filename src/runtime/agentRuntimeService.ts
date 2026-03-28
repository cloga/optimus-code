/**
 * Agent Runtime Service — Core business logic for the Agent Runtime API.
 *
 * This module extracts the runtime logic from mcp-server.ts into a transport-agnostic
 * service layer that can be consumed by:
 *   - MCP tool handlers (existing)
 *   - HTTP REST server (new)
 *   - CLI contract (new)
 *   - TypeScript/Python SDKs (via HTTP)
 *
 * No MCP, JSON-RPC, or transport dependencies — pure business logic.
 */
import crypto from 'crypto';
import { TaskManifestManager } from '../managers/TaskManifestManager';
import {
    AgentRuntimeRequest,
    AgentRuntimeRecord,
    AgentRuntimeEnvelope,
    AgentRuntimeStatus,
    buildAgentRuntimeTaskDescription,
    buildAgentRuntimeEnvelope,
    getAgentRuntimeOutputPath,
    saveAgentRuntimeRecord,
    loadAgentRuntimeRecord,
    updateAgentRuntimeRecord,
    createEventBuffer,
    pushStreamEvent,
    markStreamComplete,
} from '../utils/agentRuntime';
import { spawnAsyncWorker, runWorkerInProcess } from '../mcp/council-runner';
import { resolveRoleName } from '../utils/resolveRoleName';
import { validateRoleNotModelName, validateEngineAndModel } from '../utils/validateMcpInput';
import { loadValidEnginesAndModels, loadEngineHeartbeatTimeout } from '../mcp/worker-spawner';
import { sanitizeExternalContent, wrapUntrusted } from '../utils/sanitizeExternalContent';

// ─── Constants ───

export const DEFAULT_AGENT_RUNTIME_TIMEOUT_MS = 120_000;
export const MAX_HEARTBEAT_MS = 1_800_000;

// ─── Error types ───

export class RuntimeError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly httpStatus: number = 400,
        public readonly fix?: string
    ) {
        super(message);
        this.name = 'RuntimeError';
    }
}

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function resolveHeartbeatTimeout(workspacePath: string, requestedEngine: string | undefined, heartbeat_timeout_ms?: number): number {
    const DEFAULT_HEARTBEAT_MS = 180_000;

    if (heartbeat_timeout_ms !== undefined) {
        if (typeof heartbeat_timeout_ms !== 'number' || heartbeat_timeout_ms <= 0 || heartbeat_timeout_ms > MAX_HEARTBEAT_MS) {
            throw new RuntimeError(
                `heartbeat_timeout_ms must be between 1 and ${MAX_HEARTBEAT_MS}. Got: ${heartbeat_timeout_ms}`,
                'invalid_timeout',
                400,
                `Set heartbeat_timeout_ms to a value between 1 and ${MAX_HEARTBEAT_MS} (30 minutes). Default is 180000ms (3 minutes). This controls how long the runtime waits for engine heartbeats.`
            );
        }
        return heartbeat_timeout_ms;
    }

    const resolvedEngine = requestedEngine || (() => {
        const { engines } = loadValidEnginesAndModels(workspacePath);
        return engines.includes('claude-code') ? 'claude-code' : engines[0] || '';
    })();
    const engineTimeout = resolvedEngine ? loadEngineHeartbeatTimeout(workspacePath, resolvedEngine) : null;
    if (engineTimeout !== null) {
        if (engineTimeout <= 0 || engineTimeout > MAX_HEARTBEAT_MS) {
            console.error(`[RuntimeService] Warning: invalid heartbeat timeout ${engineTimeout} for '${resolvedEngine}'. Using default.`);
            return DEFAULT_HEARTBEAT_MS;
        }
        return engineTimeout;
    }

    return DEFAULT_HEARTBEAT_MS;
}

function buildRuntimeResumeContext(task: any, humanAnswer: string): string {
    return `You are resuming a previously paused Agent Runtime request.

## Original Runtime Request
${task.task_description || '(no description available)'}

## What You Were Working On
${task.pause_context || '(no pause context available)'}

## Question You Asked
${task.pause_question || '(no question recorded)'}

## Human Answer
${wrapUntrusted(humanAnswer, 'human-answer')}

## Instructions
Continue the run and write the final result to the same output path.`;
}

function createRuntimeRecord(request: AgentRuntimeRequest, runId: string, traceId: string, taskId: string, outputPath: string): AgentRuntimeRecord {
    const now = new Date().toISOString();
    return {
        run_id: runId,
        trace_id: traceId,
        active_task_id: taskId,
        created_at: now,
        updated_at: now,
        output_path: outputPath,
        skill: request.skill,
        output_schema: request.output_schema,
        request: {
            role: request.role,
            role_description: request.role_description,
            role_engine: request.role_engine,
            role_model: request.role_model,
            agent_id: request.agent_id,
            instructions: request.instructions,
            input: request.input,
            context_files: request.context_files,
            runtime_policy: request.runtime_policy
        },
        history: [
            { task_id: taskId, status: 'pending', at: now, note: 'Run created' }
        ]
    };
}

// ─── Input normalization ───

export function normalizeRuntimeRequest(args: any): AgentRuntimeRequest {
    const missing = ['role', 'workspace_path', 'input'].filter(k => args[k] == null || args[k] === '');
    if (missing.length > 0) {
        throw new RuntimeError(
            `Missing required parameter(s): ${missing.join(', ')}`,
            'missing_params',
            400,
            `Include all required fields in the JSON body: { "role": "<role-name>", "workspace_path": "<absolute-path>", "input": "<task-description>" }. Optional: role_engine, role_model, context_files, runtime_policy.`
        );
    }

    return {
        role: args.role,
        workspace_path: args.workspace_path,
        input: args.input,
        skill: args.skill,
        instructions: args.instructions,
        output_schema: args.output_schema,
        runtime_policy: args.runtime_policy,
        role_description: args.role_description,
        role_engine: args.role_engine,
        role_model: args.role_model,
        agent_id: args.agent_id,
        context_files: Array.isArray(args.context_files) ? args.context_files : undefined
    };
}

// ─── Core service operations ───

/**
 * Create a new Agent Runtime run and spawn the worker.
 * Returns the run ID and initial envelope.
 */
export function createRun(request: AgentRuntimeRequest): { runId: string; traceId: string; taskId: string; outputPath: string } {
    const workspacePath = request.workspace_path;
    request.role = resolveRoleName(request.role, workspacePath);
    validateRoleNotModelName(request.role);
    if (request.role_engine) {
        validateEngineAndModel(request.role_engine, request.role_model, workspacePath);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const traceId = crypto.randomUUID();
    const taskId = runId;
    const outputPath = getAgentRuntimeOutputPath(workspacePath, runId);
    const taskDescription = buildAgentRuntimeTaskDescription(request);
    const heartbeatTimeout = resolveHeartbeatTimeout(workspacePath, request.role_engine || request.runtime_policy?.fallback_engines?.[0], request.runtime_policy?.timeout_ms);
    const requiredSkills = request.skill ? [request.skill] : undefined;

    TaskManifestManager.createTask(workspacePath, {
        taskId,
        type: 'delegate_task',
        role: request.role,
        task_description: taskDescription,
        output_path: outputPath,
        workspacePath,
        context_files: request.context_files || [],
        role_description: request.role_description,
        role_engine: request.role_engine,
        role_model: request.role_model,
        required_skills: requiredSkills,
        delegation_depth: parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || '0', 10),
        agent_id: request.agent_id || undefined,
        heartbeat_timeout_ms: heartbeatTimeout,
        runtime_run_id: runId,
        runtime_trace_id: traceId,
        runtime_skill: request.skill
    });

    saveAgentRuntimeRecord(workspacePath, createRuntimeRecord(request, runId, traceId, taskId, outputPath));
    return { runId, traceId, taskId, outputPath };
}

/**
 * Build the current envelope for a run from disk state.
 */
export function getRunStatus(workspacePath: string, runId: string): AgentRuntimeEnvelope {
    const record = loadAgentRuntimeRecord(workspacePath, runId);
    if (!record) {
        throw new RuntimeError(`Agent Runtime run '${runId}' was not found.`, 'run_not_found', 404,
            `Verify the run ID is correct. Use POST /api/v1/agent/run or /agent/start to create a new run.`
        );
    }

    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[record.active_task_id];
    return buildAgentRuntimeEnvelope(record, task);
}

/**
 * Start an async run and return the initial envelope immediately.
 * Uses in-process execution for warm ACP pool reuse.
 */
export function startRun(request: AgentRuntimeRequest): AgentRuntimeEnvelope {
    if (request.role_engine) {
        validateEngineAndModel(request.role_engine, request.role_model, request.workspace_path);
    }
    const { runId } = createRun(request);
    createEventBuffer(runId);
    pushStreamEvent(runId, 'status', 'queued');
    // Fire-and-forget: run in-process for warm pool reuse, don't await
    runWorkerInProcess(runId, request.workspace_path)
        .then(() => {
            pushStreamEvent(runId, 'status', 'completed');
            markStreamComplete(runId);
        })
        .catch(err => {
            pushStreamEvent(runId, 'error', err.message || 'Execution failed');
            pushStreamEvent(runId, 'status', 'failed');
            markStreamComplete(runId);
            console.error(`[AgentRuntime] In-process run ${runId} failed:`, err.message);
        });
    return getRunStatus(request.workspace_path, runId);
}

/**
 * Run synchronously: create run, execute in-process, await completion.
 * Uses in-process execution for warm ACP pool reuse.
 * Supports retries and engine fallback.
 */
export async function runSync(request: AgentRuntimeRequest): Promise<AgentRuntimeEnvelope> {
    const retries = Math.max(0, Math.trunc(request.runtime_policy?.retries || 0));
    const fallbackEngines = Array.isArray(request.runtime_policy?.fallback_engines)
        ? request.runtime_policy!.fallback_engines!.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
        : [];
    const timeoutMs = request.runtime_policy?.timeout_ms ?? DEFAULT_AGENT_RUNTIME_TIMEOUT_MS;

    if (typeof timeoutMs !== 'number' || timeoutMs <= 0 || timeoutMs > MAX_HEARTBEAT_MS) {
        throw new RuntimeError(
            `runtime_policy.timeout_ms must be between 1 and ${MAX_HEARTBEAT_MS}. Got: ${timeoutMs}`,
            'invalid_timeout',
            400,
            `Set runtime_policy.timeout_ms to a value between 1 and ${MAX_HEARTBEAT_MS} (30 minutes). Default is ${DEFAULT_AGENT_RUNTIME_TIMEOUT_MS}ms (2 minutes).`
        );
    }

    const engineCandidates = [request.role_engine, ...fallbackEngines].filter(
        (engine, index, arr): engine is string => typeof engine === 'string' && engine.trim().length > 0 && arr.indexOf(engine) === index
    );
    const attempts = engineCandidates.length > 0 ? engineCandidates : [undefined];
    let lastEnvelope: AgentRuntimeEnvelope | null = null;

    for (let engineIndex = 0; engineIndex < attempts.length; engineIndex++) {
        const engine = attempts[engineIndex];
        for (let retryIndex = 0; retryIndex <= retries; retryIndex++) {
            const requestForAttempt: AgentRuntimeRequest = { ...request, role_engine: engine };
            if (requestForAttempt.role_engine) {
                validateEngineAndModel(requestForAttempt.role_engine, requestForAttempt.role_model, requestForAttempt.workspace_path);
            }

            const { runId } = createRun(requestForAttempt);
            // Run in-process: warm ACP pool reuse, no subprocess overhead
            await runWorkerInProcess(runId, requestForAttempt.workspace_path);
            const envelope = getRunStatus(requestForAttempt.workspace_path, runId);
            lastEnvelope = envelope;

            if (envelope.status === 'completed' || envelope.status === 'blocked_manual_intervention') {
                return envelope;
            }
        }
    }

    return lastEnvelope!;
}

/**
 * Cancel an active run.
 */
export async function cancelRun(workspacePath: string, runId: string, reason?: string): Promise<AgentRuntimeEnvelope> {
    const record = loadAgentRuntimeRecord(workspacePath, runId);
    if (!record) {
        throw new RuntimeError(`Agent Runtime run '${runId}' was not found.`, 'run_not_found', 404,
            `Verify the run ID is correct. Use POST /api/v1/agent/run or /agent/start to create a new run.`
        );
    }

    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[record.active_task_id];
    if (!task) {
        throw new RuntimeError(`Active task '${record.active_task_id}' for run '${runId}' was not found.`, 'task_not_found', 404,
            `The task record was deleted or corrupted. Create a new run instead.`
        );
    }

    const terminalStatuses = ['verified', 'completed', 'failed', 'partial', 'degraded', 'cancelled'];
    if (terminalStatuses.includes(task.status)) {
        return buildAgentRuntimeEnvelope(record, task);
    }

    if (task.pid) {
        try { process.kill(task.pid); } catch (e: any) {
            if (e && e.code !== 'ESRCH') throw e;
        }
    }

    const now = Date.now();
    const message = reason || 'Cancelled by application runtime request.';
    TaskManifestManager.updateTask(workspacePath, task.taskId, {
        status: 'cancelled',
        error_message: message,
        cancellation_reason: message,
        cancelled_at: now,
        completed_at: now
    });

    updateAgentRuntimeRecord(workspacePath, runId, (current) => ({
        ...current,
        updated_at: new Date(now).toISOString(),
        history: [
            ...current.history,
            { task_id: current.active_task_id, status: 'cancelled', at: new Date(now).toISOString(), note: message }
        ]
    }));

    return getRunStatus(workspacePath, runId);
}

/**
 * Resume a run that is blocked on manual intervention.
 */
export function resumeRun(workspacePath: string, runId: string, humanAnswer: string): AgentRuntimeEnvelope {
    const record = loadAgentRuntimeRecord(workspacePath, runId);
    if (!record) {
        throw new RuntimeError(`Agent Runtime run '${runId}' was not found.`, 'run_not_found', 404,
            `Verify the run ID is correct. Use POST /api/v1/agent/run or /agent/start to create a new run.`
        );
    }

    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const currentTask = manifest[record.active_task_id];
    const actualStatus = currentTask?.status || 'unknown';
    if (!currentTask || (currentTask.status !== 'awaiting_input' && currentTask.status !== 'expired')) {
        throw new RuntimeError(
            `Run '${runId}' is not waiting for manual intervention (current status: ${actualStatus}).`,
            'invalid_state',
            400,
            `Resume is only valid when run status is 'blocked_manual_intervention'. Current status: '${actualStatus}'. Use GET /api/v1/agent/runs/${runId} to check status before resuming.`
        );
    }

    const { sanitized: sanitizedAnswer } = sanitizeExternalContent(humanAnswer, `agent-runtime:${runId}:human-answer`);
    const resumeTaskId = `${runId}_resume_${Date.now()}`;
    const now = new Date().toISOString();

    TaskManifestManager.updateTask(workspacePath, currentTask.taskId, {
        status: 'completed',
        human_answer: sanitizedAnswer,
        resume_task_id: resumeTaskId,
        completed_at: Date.now()
    });

    TaskManifestManager.createTask(workspacePath, {
        taskId: resumeTaskId,
        type: 'delegate_task',
        role: currentTask.role!,
        task_description: buildRuntimeResumeContext(currentTask, sanitizedAnswer),
        output_path: record.output_path,
        workspacePath,
        context_files: currentTask.context_files || [],
        role_description: currentTask.role_description,
        role_engine: currentTask.role_engine,
        role_model: currentTask.role_model,
        required_skills: currentTask.required_skills,
        delegation_depth: currentTask.delegation_depth,
        parent_issue_number: currentTask.parent_issue_number,
        github_issue_number: currentTask.github_issue_number,
        heartbeat_timeout_ms: currentTask.heartbeat_timeout_ms,
        runtime_run_id: runId,
        runtime_trace_id: currentTask.runtime_trace_id,
        runtime_skill: currentTask.runtime_skill,
        agent_id: currentTask.agent_id
    });

    updateAgentRuntimeRecord(workspacePath, runId, (existing) => ({
        ...existing,
        active_task_id: resumeTaskId,
        updated_at: now,
        history: [
            ...existing.history,
            { task_id: resumeTaskId, status: 'pending', at: now, note: 'Run resumed with direct human answer' }
        ]
    }));

    // Fire-and-forget: run in-process for warm pool reuse
    runWorkerInProcess(resumeTaskId, workspacePath).catch(err =>
        console.error(`[AgentRuntime] In-process resume ${resumeTaskId} failed:`, err.message)
    );
    return getRunStatus(workspacePath, runId);
}

/**
 * Poll for run completion. Returns when terminal status or timeout.
 */
export async function waitForCompletion(workspacePath: string, runId: string, timeoutMs: number): Promise<AgentRuntimeEnvelope> {
    const startedAt = Date.now();
    const terminalStatuses: AgentRuntimeStatus[] = ['completed', 'failed', 'blocked_manual_intervention', 'cancelled'];

    while (true) {
        const envelope = getRunStatus(workspacePath, runId);
        if (terminalStatuses.includes(envelope.status)) {
            return envelope;
        }

        if (Date.now() - startedAt > timeoutMs) {
            return cancelRun(workspacePath, runId, `Run exceeded timeout of ${timeoutMs}ms.`);
        }

        await sleep(1000);
    }
}
