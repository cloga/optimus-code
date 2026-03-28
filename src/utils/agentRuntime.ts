import fs from 'fs';
import path from 'path';
import { TaskRecord } from '../managers/TaskManifestManager';
import { resolveOptimusPath } from './worktree';

export type AgentRuntimeStatus =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'blocked_manual_intervention'
    | 'cancelled';

export interface AgentRuntimePolicy {
    mode?: 'sync' | 'async';
    timeout_ms?: number;
    retries?: number;
    fallback_engines?: string[];
}

export interface AgentRuntimeRequest {
    role: string;
    workspace_path: string;
    input: unknown;
    skill?: string;
    instructions?: string;
    output_schema?: unknown;
    runtime_policy?: AgentRuntimePolicy;
    role_description?: string;
    role_engine?: string;
    role_model?: string;
    agent_id?: string;
    context_files?: string[];
}

export interface AgentRuntimeRecord {
    run_id: string;
    trace_id: string;
    active_task_id: string;
    created_at: string;
    updated_at: string;
    output_path: string;
    skill?: string;
    output_schema?: unknown;
    usage?: Record<string, unknown>;
    stop_reason?: string;
    request: {
        role: string;
        role_description?: string;
        role_engine?: string;
        role_model?: string;
        agent_id?: string;
        instructions?: string;
        input: unknown;
        context_files?: string[];
        runtime_policy?: AgentRuntimePolicy;
    };
    history: Array<{
        task_id: string;
        status: string;
        at: string;
        note?: string;
    }>;
}

export interface AgentRuntimeEnvelope {
    run_id: string;
    trace_id: string;
    status: AgentRuntimeStatus;
    result?: unknown;
    error_code?: string;
    error_message?: string;
    requires_manual_intervention: boolean;
    action_required?: string;
    runtime_metadata: {
        role: string;
        skill?: string;
        engine?: string;
        model?: string;
        session_id?: string;
        task_id?: string;
        agent_id?: string;
        duration_ms?: number;
        output_path: string;
        retries_attempted: number;
        created_at: string;
        updated_at: string;
        usage?: Record<string, unknown>;
        stop_reason?: string;
    };
}

export function ensureAgentRuntimeDirectories(workspacePath: string): { stateDir: string; outputDir: string } {
    const stateDir = resolveOptimusPath(workspacePath, 'state', 'agent-runtime');
    const outputDir = resolveOptimusPath(workspacePath, 'results', 'agent-runtime');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    return { stateDir, outputDir };
}

export function getAgentRuntimeRecordPath(workspacePath: string, runId: string): string {
    const { stateDir } = ensureAgentRuntimeDirectories(workspacePath);
    return path.join(stateDir, `${runId}.json`);
}

export function getAgentRuntimeOutputPath(workspacePath: string, runId: string): string {
    const { outputDir } = ensureAgentRuntimeDirectories(workspacePath);
    return path.join(outputDir, `${runId}.json`);
}

export function saveAgentRuntimeRecord(workspacePath: string, record: AgentRuntimeRecord): void {
    const recordPath = getAgentRuntimeRecordPath(workspacePath, record.run_id);
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');
}

export function loadAgentRuntimeRecord(workspacePath: string, runId: string): AgentRuntimeRecord | null {
    const recordPath = getAgentRuntimeRecordPath(workspacePath, runId);
    if (!fs.existsSync(recordPath)) {
        return null;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        return raw as AgentRuntimeRecord;
    } catch {
        return null;
    }
}

export function appendAgentRuntimeHistory(
    workspacePath: string,
    runId: string,
    entry: AgentRuntimeRecord['history'][number]
): AgentRuntimeRecord | null {
    const record = loadAgentRuntimeRecord(workspacePath, runId);
    if (!record) {
        return null;
    }

    record.history.push(entry);
    record.updated_at = entry.at;
    saveAgentRuntimeRecord(workspacePath, record);
    return record;
}

export function updateAgentRuntimeRecord(
    workspacePath: string,
    runId: string,
    updater: (record: AgentRuntimeRecord) => AgentRuntimeRecord
): AgentRuntimeRecord | null {
    const record = loadAgentRuntimeRecord(workspacePath, runId);
    if (!record) {
        return null;
    }

    const updated = updater(record);
    saveAgentRuntimeRecord(workspacePath, updated);
    return updated;
}

// ─── Streaming Event Buffer ───

export type StreamEventType = 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'step_start' | 'step_complete' | 'status' | 'error' | 'done';

export interface StreamEvent {
    type: StreamEventType;
    data: string;
    timestamp: string;
    sequence: number;
}

interface RunEventBuffer {
    events: StreamEvent[];
    listeners: Set<(event: StreamEvent) => void>;
    completed: boolean;
    sequenceCounter: number;
    cleanupTimer?: ReturnType<typeof setTimeout>;
}

const EVENT_BUFFER_SIZE = 2000;
const EVENT_BUFFER_TTL_MS = 5 * 60 * 1000;

const eventBuffers = new Map<string, RunEventBuffer>();

export function createEventBuffer(runId: string): RunEventBuffer {
    const existing = eventBuffers.get(runId);
    if (existing) return existing;

    const buffer: RunEventBuffer = {
        events: [],
        listeners: new Set(),
        completed: false,
        sequenceCounter: 0,
    };
    eventBuffers.set(runId, buffer);
    return buffer;
}

export function pushStreamEvent(runId: string, type: StreamEventType, data: string): StreamEvent | null {
    const buffer = eventBuffers.get(runId);
    if (!buffer) return null;

    const event: StreamEvent = {
        type,
        data,
        timestamp: new Date().toISOString(),
        sequence: ++buffer.sequenceCounter,
    };

    buffer.events.push(event);
    if (buffer.events.length > EVENT_BUFFER_SIZE) {
        buffer.events.shift();
    }

    for (const listener of buffer.listeners) {
        try { listener(event); } catch { /* best-effort */ }
    }

    return event;
}

export function subscribeToEvents(
    runId: string,
    sinceSequence: number,
    listener: (event: StreamEvent) => void
): { unsubscribe: () => void; completed: boolean } {
    const buffer = eventBuffers.get(runId);
    if (!buffer) return { unsubscribe: () => {}, completed: true };

    for (const event of buffer.events) {
        if (event.sequence > sinceSequence) {
            try { listener(event); } catch { /* best-effort */ }
        }
    }

    buffer.listeners.add(listener);
    return {
        unsubscribe: () => buffer.listeners.delete(listener),
        completed: buffer.completed,
    };
}

export function markStreamComplete(runId: string): void {
    const buffer = eventBuffers.get(runId);
    if (!buffer) return;

    pushStreamEvent(runId, 'done', '');
    buffer.completed = true;

    buffer.cleanupTimer = setTimeout(() => {
        eventBuffers.delete(runId);
    }, EVENT_BUFFER_TTL_MS);
}

export function getEventBuffer(runId: string): RunEventBuffer | undefined {
    return eventBuffers.get(runId);
}

export function clearEventBuffer(runId: string): void {
    const buffer = eventBuffers.get(runId);
    if (buffer?.cleanupTimer) clearTimeout(buffer.cleanupTimer);
    eventBuffers.delete(runId);
}

export function buildAgentRuntimeTaskDescription(request: AgentRuntimeRequest): string {
    const skillLine = request.skill ? `- **Skill / playbook**: \`${request.skill}\`\n` : '';
    const instructionsLine = request.instructions ? `${request.instructions.trim()}\n\n` : '';
    const schemaLine = request.output_schema !== undefined
        ? `## Output Contract\nReturn ONLY valid JSON that matches this schema:\n\n\`\`\`json\n${JSON.stringify(request.output_schema, null, 2)}\n\`\`\`\n\nIf you cannot satisfy the schema, explain the failure briefly in JSON with explicit fields and no markdown.\n\n`
        : `## Output Contract\nReturn the final result directly. Prefer machine-readable JSON when it makes sense for the request, and avoid extra preamble.\n\n`;

    return `You are executing an application-facing Agent Runtime request inside Optimus Code.

## Boundary
- Treat this as runtime-owned execution semantics, not application business logic.
- Do not perform DB writes, persistence orchestration, or external side effects unless explicitly asked in the request.
- Focus on producing the requested domain result from the supplied input.

## Request
- **Role**: \`${request.role}\`
${skillLine}${request.role_description ? `- **Role description**: ${request.role_description}\n` : ''}- **Trace ID**: generated by runtime

## Domain Instructions
${instructionsLine}${schemaLine}## Input
\`\`\`json
${JSON.stringify(request.input, null, 2)}
\`\`\`
`;
}

export function mapTaskStatusToRuntimeStatus(task: TaskRecord | null | undefined): AgentRuntimeStatus {
    if (!task) {
        return 'failed';
    }

    switch (task.status) {
        case 'pending':
        case 'blocked':
            return 'queued';
        case 'running':
            return 'running';
        case 'awaiting_input':
        case 'expired':
            return 'blocked_manual_intervention';
        case 'cancelled':
            return 'cancelled';
        case 'verified':
        case 'completed':
            return 'completed';
        case 'partial':
        case 'degraded':
        case 'failed':
        default:
            return 'failed';
    }
}

/**
 * Try to extract a JSON value from text that may contain markdown prose/code fences.
 * Handles common patterns:
 *   - ```json\n{...}\n```
 *   - ```\n{...}\n```
 *   - Prose before/after a JSON object or array
 */
export function extractJsonFromText(text: string): unknown | undefined {
    // Strategy 1: Extract from ```json ... ``` or ``` ... ``` code fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        try {
            return JSON.parse(fenceMatch[1].trim());
        } catch { /* fall through */ }
    }

    // Strategy 2: Find the outermost { } or [ ] and try parsing
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    const start = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? firstBrace : firstBracket;
    if (start >= 0) {
        const open = text[start];
        const close = open === '{' ? '}' : ']';
        const lastClose = text.lastIndexOf(close);
        if (lastClose > start) {
            try {
                return JSON.parse(text.slice(start, lastClose + 1));
            } catch { /* fall through */ }
        }
    }

    return undefined;
}

function readOutputArtifact(outputPath: string): { exists: boolean; rawText?: string; parsed?: unknown; parseError?: string } {
    if (!fs.existsSync(outputPath)) {
        return { exists: false };
    }

    const rawText = fs.readFileSync(outputPath, 'utf8').trim();
    if (!rawText) {
        return { exists: true, rawText: '' };
    }

    // Try direct parse first
    try {
        return { exists: true, rawText, parsed: JSON.parse(rawText) };
    } catch { /* fall through to extraction */ }

    // Try extracting JSON from markdown/prose wrapping
    const extracted = extractJsonFromText(rawText);
    if (extracted !== undefined) {
        // Self-heal: write clean JSON back to artifact file so downstream
        // consumers reading output_path directly get machine-readable JSON.
        try {
            fs.writeFileSync(outputPath, JSON.stringify(extracted, null, 2), 'utf8');
        } catch { /* best-effort, don't fail if write fails */ }
        return { exists: true, rawText, parsed: extracted };
    }

    // All extraction attempts failed
    return {
        exists: true,
        rawText,
        parseError: 'Response contains non-JSON text. Tried extracting from markdown code fences and brace-matching but no valid JSON found.'
    };
}

function buildFailureFields(task: TaskRecord | null | undefined, record: AgentRuntimeRecord, outputInfo: ReturnType<typeof readOutputArtifact>): Pick<AgentRuntimeEnvelope, 'error_code' | 'error_message' | 'action_required'> {
    if (!task) {
        return {
            error_code: 'run_not_found',
            error_message: `Agent Runtime run '${record.run_id}' was not found in the task manifest.`
        };
    }

    if (task.status === 'awaiting_input' || task.status === 'expired') {
        return {
            error_code: 'manual_intervention_required',
            error_message: task.error_message,
            action_required: task.pause_question || task.error_message || 'Human input is required to continue this run.'
        };
    }

    if (task.status === 'cancelled') {
        return {
            error_code: 'run_cancelled',
            error_message: task.error_message || task.cancellation_reason || 'The run was cancelled.'
        };
    }

    if (record.output_schema !== undefined && outputInfo.exists && outputInfo.parseError) {
        return {
            error_code: 'invalid_structured_output',
            error_message: `Expected JSON output but failed to parse result: ${outputInfo.parseError}`
        };
    }

    if (!outputInfo.exists && (task.status === 'verified' || task.status === 'completed')) {
        return {
            error_code: 'missing_output_artifact',
            error_message: `Run finished without producing an output artifact at '${record.output_path}'.`
        };
    }

    return {
        error_code: task.status === 'partial' || task.status === 'degraded' ? 'partial_result' : 'runtime_execution_failed',
        error_message: task.error_message || 'The agent runtime execution failed.'
    };
}

export function buildAgentRuntimeEnvelope(
    record: AgentRuntimeRecord,
    task: TaskRecord | null | undefined
): AgentRuntimeEnvelope {
    const mappedStatus = mapTaskStatusToRuntimeStatus(task);
    const outputInfo = readOutputArtifact(record.output_path);
    const durationMs = task ? Math.max(0, (task.completed_at || Date.now()) - task.startTime) : undefined;
    const retriesAttempted = Math.max(0, record.history.length - 1);
    const updatedAt = task
        ? new Date(task.completed_at || task.cancelled_at || task.heartbeatTime || Date.parse(record.updated_at)).toISOString()
        : record.updated_at;

    let status = mappedStatus;
    let result: unknown;
    if (outputInfo.exists) {
        result = outputInfo.parsed !== undefined ? outputInfo.parsed : outputInfo.rawText;
    }

    if (status === 'completed' && record.output_schema !== undefined && outputInfo.parseError) {
        status = 'failed';
    }

    // If the task "completed" but the output file is completely missing, mark as failed
    if (status === 'completed' && !outputInfo.exists) {
        status = 'failed';
    }

    const failureFields = status === 'completed'
        ? {}
        : buildFailureFields(task, record, outputInfo);

    return {
        run_id: record.run_id,
        trace_id: record.trace_id,
        status,
        ...(result !== undefined ? { result } : {}),
        ...(failureFields.error_code ? { error_code: failureFields.error_code } : {}),
        ...(failureFields.error_message ? { error_message: failureFields.error_message } : {}),
        requires_manual_intervention: status === 'blocked_manual_intervention',
        ...(failureFields.action_required ? { action_required: failureFields.action_required } : {}),
        runtime_metadata: {
            role: record.request.role,
            ...(record.skill ? { skill: record.skill } : {}),
            ...(task?.resolved_engine ? { engine: task.resolved_engine } : task?.role_engine ? { engine: task.role_engine } : {}),
            ...(task?.resolved_model ? { model: task.resolved_model } : task?.role_model ? { model: task.role_model } : {}),
            ...(task?.session_id ? { session_id: task.session_id } : {}),
            ...(task?.taskId ? { task_id: task.taskId } : {}),
            ...(task?.agent_id ? { agent_id: task.agent_id } : record.request.agent_id ? { agent_id: record.request.agent_id } : {}),
            ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
            output_path: record.output_path,
            retries_attempted: retriesAttempted,
            created_at: record.created_at,
            updated_at: updatedAt,
            ...(record.usage ? { usage: record.usage } : {}),
            ...(record.stop_reason ? { stop_reason: record.stop_reason } : {})
        }
    };
}
