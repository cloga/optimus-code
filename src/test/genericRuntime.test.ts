import { describe, it, expect } from 'vitest';
import path from 'path';
import {
    runGenericSync,
    startGenericRun,
    getGenericRunStatus,
    cancelGenericRun,
    listGenericEngines,
} from '../runtime/genericRuntime';

describe('genericRuntime', () => {
    describe('listGenericEngines', () => {
        it('returns available engines', () => {
            const engines = listGenericEngines();
            expect(engines.length).toBeGreaterThan(0);
            expect(engines).toContain('github-copilot');
        });
    });

    describe('validation', () => {
        it('rejects empty prompt', async () => {
            await expect(runGenericSync({ prompt: '' })).rejects.toThrow(/prompt.*required/i);
        });

        it('rejects missing prompt', async () => {
            await expect(runGenericSync({} as any)).rejects.toThrow(/prompt.*required/i);
        });

        it('rejects invalid timeout_ms', async () => {
            await expect(runGenericSync({ prompt: 'test', timeout_ms: -1 })).rejects.toThrow(/timeout_ms/);
        });

        it('rejects timeout_ms over 30 minutes', async () => {
            await expect(runGenericSync({ prompt: 'test', timeout_ms: 2_000_000 })).rejects.toThrow(/timeout_ms/);
        });
    });

    describe('startGenericRun', () => {
        it('returns running envelope immediately', () => {
            // Use a fake engine that will fail — we only care about the envelope structure
            const envelope = startGenericRun({ prompt: 'hello', engine: 'github-copilot' });
            expect(envelope.run_id).toMatch(/^run_/);
            expect(envelope.status).toBe('running');
            expect(envelope.metadata.created_at).toBeDefined();
        });
    });

    describe('getGenericRunStatus', () => {
        it('returns status for known run', () => {
            const workspaceRoot = process.cwd();
            const started = startGenericRun({ prompt: 'hello', engine: 'github-copilot', workspace_path: path.join(workspaceRoot, 'src', 'runtime') });
            const status = getGenericRunStatus(started.run_id, path.join(workspaceRoot, 'src', 'runtime'));
            expect(status.run_id).toBe(started.run_id);
            expect(status.status).toBe('running');
        });

        it('throws for unknown run', () => {
            expect(() => getGenericRunStatus('nonexistent')).toThrow(/not found/i);
        });

        it('rejects status lookups from a different workspace', () => {
            const started = startGenericRun({ prompt: 'hello', engine: 'github-copilot', workspace_path: 'C:\\workspace-a' });
            expect(() => getGenericRunStatus(started.run_id, 'C:\\workspace-b')).toThrow(/workspace/i);
        });
    });

    describe('cancelGenericRun', () => {
        it('cancels a running run', () => {
            const workspaceRoot = process.cwd();
            const started = startGenericRun({ prompt: 'hello', engine: 'github-copilot', workspace_path: path.join(workspaceRoot, 'src') });
            const cancelled = cancelGenericRun(started.run_id, workspaceRoot);
            expect(cancelled.status).toBe('cancelled');
            expect(cancelled.error?.code).toBe('cancelled');
        });

        it('throws for unknown run', () => {
            expect(() => cancelGenericRun('nonexistent')).toThrow(/not found/i);
        });

        it('rejects cancellation from a different workspace', () => {
            const started = startGenericRun({ prompt: 'hello', engine: 'github-copilot', workspace_path: 'C:\\workspace-a' });
            expect(() => cancelGenericRun(started.run_id, 'C:\\workspace-b')).toThrow(/workspace/i);
        });
    });
});
