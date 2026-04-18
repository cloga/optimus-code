import path from 'path';
import { describe, expect, it } from 'vitest';
import {
    buildHeartbeatSseFrame,
    buildOverflowRuntimeArgs,
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
});
