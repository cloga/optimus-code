import { describe, it, expect } from 'vitest';
import { TaskDelegationResult, formatTaskResultAsText } from '../types/TaskDelegationResult.js';
import { extractTaskResult, determineTaskStatus, TaskResultMetadata } from '../harness/resultFormatter.js';
import { synthesizeIfRequired } from '../mcp/synthesis-coordinator.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('TaskDelegationResult', () => {
    describe('formatTaskResultAsText', () => {
        it('formats a successful result as readable markdown', () => {
            const result: TaskDelegationResult = {
                status: 'success',
                task_id: 'test-task-1',
                role: 'dev',
                engine: 'claude-code',
                model: 'claude-opus-4.6',
                session_id: 'sess-123',
                output_path: '.optimus/results/test.md',
                output_size_bytes: 1500,
                summary: 'Task completed successfully with all changes applied.',
                usage: { input_tokens: 5000, output_tokens: 2000, total_tokens: 7000 },
                execution_time_ms: 15000,
                stop_reason: 'end_turn',
                tier_resolved: 'T2',
                timestamp: '2026-04-03T08:00:00.000Z',
            };
            const text = formatTaskResultAsText(result);
            expect(text).toContain('✅');
            expect(text).toContain('test-task-1');
            expect(text).toContain('claude-code');
            expect(text).toContain('7000');
            expect(text).toContain('15000ms');
            expect(text).toContain('T2');
        });

        it('formats a failed result with error details', () => {
            const result: TaskDelegationResult = {
                status: 'failed',
                task_id: 'test-task-2',
                role: 'dev',
                engine: 'unknown',
                output_path: '.optimus/results/fail.md',
                output_size_bytes: 0,
                summary: '',
                usage: {},
                execution_time_ms: 500,
                tier_resolved: 'T3',
                timestamp: '2026-04-03T08:00:00.000Z',
                errors: ['Engine not available', 'Connection timeout'],
            };
            const text = formatTaskResultAsText(result);
            expect(text).toContain('❌');
            expect(text).toContain('Failed');
            expect(text).toContain('Engine not available');
            expect(text).toContain('Connection timeout');
        });

        it('formats partial result with warnings', () => {
            const result: TaskDelegationResult = {
                status: 'partial',
                task_id: 'test-task-3',
                role: 'qa-engineer',
                engine: 'github-copilot',
                output_path: '.optimus/results/partial.md',
                output_size_bytes: 800,
                summary: 'Some tests failed.',
                usage: { total_tokens: 3000 },
                execution_time_ms: 8000,
                tier_resolved: 'T1',
                timestamp: '2026-04-03T08:00:00.000Z',
                validation_warnings: ['Unfinished TODO markers detected'],
            };
            const text = formatTaskResultAsText(result);
            expect(text).toContain('⚠️');
            expect(text).toContain('Partial');
            expect(text).toContain('Unfinished TODO markers detected');
        });
    });
});

describe('resultFormatter', () => {
    describe('determineTaskStatus', () => {
        it('returns failed for parse errors', () => {
            expect(determineTaskStatus('some output', 'JSON parse error')).toBe('failed');
        });

        it('returns failed for empty output', () => {
            expect(determineTaskStatus('', undefined)).toBe('failed');
            expect(determineTaskStatus('short', undefined)).toBe('failed');
        });

        it('returns partial for validation warnings', () => {
            expect(determineTaskStatus('a'.repeat(50), undefined, ['warning 1'])).toBe('partial');
        });

        it('returns success for clean output', () => {
            expect(determineTaskStatus('a'.repeat(50), undefined, [])).toBe('success');
            expect(determineTaskStatus('a'.repeat(50))).toBe('success');
        });
    });

    describe('extractTaskResult', () => {
        it('extracts a structured result from exec data', () => {
            const execResult = {
                output: 'This is a test output that is long enough to pass validation checks easily.',
                usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
                durationMs: 5000,
                stopReason: 'end_turn',
                sessionId: 'sess-abc',
            };
            const metadata: TaskResultMetadata = {
                taskId: 'task-123',
                role: 'dev',
                engine: 'claude-code',
                model: 'claude-opus-4.6',
                outputPath: '/nonexistent/path.md',
                tierResolved: 'T2',
            };
            const result = extractTaskResult(execResult, metadata, Date.now() - 5000);

            expect(result.status).toBe('success');
            expect(result.task_id).toBe('task-123');
            expect(result.role).toBe('dev');
            expect(result.engine).toBe('claude-code');
            expect(result.model).toBe('claude-opus-4.6');
            expect(result.session_id).toBe('sess-abc');
            expect(result.usage.total_tokens).toBe(150);
            expect(result.tier_resolved).toBe('T2');
            expect(result.summary).toContain('This is a test output');
            expect(result.timestamp).toBeTruthy();
        });

        it('handles empty output as failed', () => {
            const result = extractTaskResult(
                { output: '' },
                { taskId: 't1', role: 'dev', engine: 'test', outputPath: '/x', tierResolved: 'T3' },
                Date.now()
            );
            expect(result.status).toBe('failed');
            expect(result.errors).toContain('Output is empty or too short');
        });
    });
});

describe('synthesis-coordinator', () => {
    describe('synthesizeIfRequired', () => {
        it('returns false when synthesis not required', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-test-'));
            const stateDir = path.join(tmpDir, '.optimus', 'state');
            fs.mkdirSync(stateDir, { recursive: true });

            const manifest = {
                'task-1': { status: 'completed', output_path: 'test.md', role: 'dev' }
            };
            fs.writeFileSync(path.join(stateDir, 'task-manifest.json'), JSON.stringify(manifest));

            const result = await synthesizeIfRequired(tmpDir, 'task-1');
            expect(result).toBe(false);

            // Cleanup
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });
});
