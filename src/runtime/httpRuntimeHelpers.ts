import { RuntimeError } from './agentRuntimeService';
import { resolveWorkspaceRoot } from '../utils/worktree';

export function resolveWorkspaceFromBody(defaultWorkspacePath: string, requestWorkspacePath?: string): string {
    const workspacePath = (requestWorkspacePath || defaultWorkspacePath || '').trim();
    if (workspacePath) {
        return resolveWorkspaceRoot(workspacePath) || workspacePath;
    }

    throw new RuntimeError(
        'workspace_path is required when runtime server is started without --workspace.',
        'missing_workspace',
        400,
        'Include workspace_path in the request body: { "workspace_path": "/path/to/project", ... }'
    );
}

export function resolveWorkspaceFromHeader(defaultWorkspacePath: string, headerWorkspacePath?: string): string {
    const workspacePath = (headerWorkspacePath || defaultWorkspacePath || '').trim();
    if (workspacePath) {
        return resolveWorkspaceRoot(workspacePath) || workspacePath;
    }

    throw new RuntimeError(
        'X-Optimus-Workspace is required when runtime server is started without --workspace.',
        'missing_workspace',
        400,
        'Include the X-Optimus-Workspace header with the workspace root for status or stream requests.'
    );
}

export function buildOverflowRuntimeArgs(overflowPort: number, idleTimeoutSeconds: number): string[] {
    return [
        '--port', String(overflowPort),
        '--overflow',
        '--idle-timeout', String(idleTimeoutSeconds),
    ];
}

export function buildHeartbeatSseFrame(runId: string): string {
    return `event: heartbeat\ndata: ${JSON.stringify({
        type: 'heartbeat',
        run_id: runId,
        timestamp: new Date().toISOString(),
    })}\n\n`;
}

export interface RuntimeCapacitySnapshot {
    activeRuns: number;
    maxConcurrentRuns: number;
    overflowActiveRuns: number;
    overflowInstances: number;
    maxOverflowInstances: number;
}

export function buildCapacityLimitError(snapshot: RuntimeCapacitySnapshot): { code: string; message: string; fix: string } {
    const currentInstances = 1 + snapshot.overflowInstances;
    const maxInstances = 1 + snapshot.maxOverflowInstances;
    const currentActiveRuns = snapshot.activeRuns + snapshot.overflowActiveRuns;
    const currentCapacity = snapshot.maxConcurrentRuns * currentInstances;
    const maxCapacity = snapshot.maxConcurrentRuns * maxInstances;

    return {
        code: 'concurrency_limit',
        message: `All runtime instances are at capacity (${currentActiveRuns}/${currentCapacity} current concurrent runs across ${currentInstances} instance(s); max capacity ${maxCapacity} across ${maxInstances} instance(s)).`,
        fix: `Wait for an active run to finish, retry later, or increase capacity with OPTIMUS_MAX_CONCURRENT (per-instance limit) and OPTIMUS_MAX_OVERFLOW (overflow instance limit). Current settings: OPTIMUS_MAX_CONCURRENT=${snapshot.maxConcurrentRuns}, OPTIMUS_MAX_OVERFLOW=${snapshot.maxOverflowInstances}.`,
    };
}

export function isGenericRunTerminalStatus(status: string): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}
