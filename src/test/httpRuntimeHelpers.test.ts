import path from 'path';
import fs from 'fs';
import { describe, expect, it } from 'vitest';
import {
    buildHeartbeatSseFrame,
    buildCapacityLimitError,
    buildOverflowRuntimeArgs,
    isGenericRunTerminalStatus,
    resolveWorkspaceFromBody,
    resolveWorkspaceFromHeader,
} from '../runtime/httpRuntimeHelpers';

describe('httpRuntimeHelpers', () => {
    it('requires workspace_path in per-request mode for body-driven endpoints', () => {
        expect(() => resolveWorkspaceFromBody('', undefined)).toThrow(/workspace_path is required/i);
    });

    it('uses request workspace when provided in the body', () => {
        expect(resolveWorkspaceFromBody('', path.join(process.cwd(), 'src', 'runtime'))).toBe(process.cwd());
    });

    it('requires X-Optimus-Workspace in per-request mode for status endpoints', () => {
        expect(() => resolveWorkspaceFromHeader('', undefined)).toThrow(/X-Optimus-Workspace is required/i);
    });

    it('uses header workspace when provided', () => {
        expect(resolveWorkspaceFromHeader('', path.join(process.cwd(), 'src'))).toBe(process.cwd());
    });

    it('builds overflow args without binding to a single workspace', () => {
        expect(buildOverflowRuntimeArgs(3101, 60)).toEqual([
            '--port', '3101',
            '--overflow',
            '--idle-timeout', '60',
        ]);
    });

    it('builds a heartbeat SSE frame with an explicit heartbeat event payload', () => {
        const frame = buildHeartbeatSseFrame('run_123');
        expect(frame).toContain('event: heartbeat');
        expect(frame).toContain('"run_id":"run_123"');
        expect(frame).toContain('"type":"heartbeat"');
    });

    it('builds actionable runtime capacity errors', () => {
        const error = buildCapacityLimitError({
            activeRuns: 5,
            maxConcurrentRuns: 5,
            overflowActiveRuns: 10,
            overflowInstances: 2,
            maxOverflowInstances: 2,
        });

        expect(error.code).toBe('concurrency_limit');
        expect(error.message).toContain('15/15');
        expect(error.fix).toContain('OPTIMUS_MAX_CONCURRENT=5');
        expect(error.fix).toContain('OPTIMUS_MAX_OVERFLOW=2');
    });

    it('recognizes generic runtime terminal statuses', () => {
        expect(isGenericRunTerminalStatus('completed')).toBe(true);
        expect(isGenericRunTerminalStatus('failed')).toBe(true);
        expect(isGenericRunTerminalStatus('cancelled')).toBe(true);
        expect(isGenericRunTerminalStatus('running')).toBe(false);
    });

    it('documents scheduler HTTP endpoints as app-layer envelopes in source', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src', 'runtime', 'http-server.ts'), 'utf8');

        expect(source).toContain("scheduler_scope: 'optimus_application_layer'");
        expect(source).toContain('Application-layer scheduler tick; does not replace Copilot core turn scheduling.');
        expect(source).toContain('parseOptionalJsonBody');
        expect(source).toContain("'/api/v1/scheduler/tasks/:id/pause'");
        expect(source).toContain("'/api/v1/scheduler/tasks/:id/resume'");
        expect(source).toContain("'/api/v1/scheduler/tasks/:id/reassign'");
        expect(source).toContain("'/api/v1/scheduler/tasks/:id/checkpoint'");
        expect(source).toContain("'/api/v1/scheduler/tasks/:id/handoff'");
        expect(source).toContain("'/api/v1/scheduler/tasks/:id/yield'");
        expect(source).toContain("'/api/v1/scheduler/tasks/:id'");
    });

    it('only starts the autonomous scheduler loop on the primary runtime instance', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src', 'runtime', 'http-server.ts'), 'utf8');

        expect(source).toContain('if (workspacePath && !isOverflow)');
        expect(source).toContain('startMasterSchedulerLoop(workspacePath');
    });
});
