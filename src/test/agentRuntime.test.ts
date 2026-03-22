import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    AgentRuntimeRecord,
    AgentRuntimeEnvelope,
    buildAgentRuntimeEnvelope,
    buildAgentRuntimeTaskDescription,
    mapTaskStatusToRuntimeStatus,
    saveAgentRuntimeRecord,
    loadAgentRuntimeRecord,
    appendAgentRuntimeHistory,
    ensureAgentRuntimeDirectories
} from '../utils/agentRuntime';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-test-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
});

function makeRecord(overrides: Partial<AgentRuntimeRecord> = {}): AgentRuntimeRecord {
    return {
        run_id: 'run_test',
        trace_id: 'trace_test',
        active_task_id: 'run_test',
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
        output_path: '/tmp/fake.json',
        request: { role: 'test-role', input: { x: 1 } },
        history: [{ task_id: 'run_test', status: 'pending', at: '2026-03-22T00:00:00.000Z' }],
        ...overrides
    };
}

function makeTask(overrides: Record<string, any> = {}): any {
    return {
        taskId: 'run_test',
        type: 'delegate_task',
        status: 'verified',
        startTime: Date.now() - 5000,
        heartbeatTime: Date.now(),
        workspacePath: '/tmp',
        output_path: '/tmp/fake.json',
        ...overrides
    };
}

describe('agent runtime — status mapping', () => {
    it('maps all manifest statuses into application-facing runtime statuses', () => {
        const cases: Array<[string, string]> = [
            ['pending', 'queued'],
            ['blocked', 'queued'],
            ['running', 'running'],
            ['awaiting_input', 'blocked_manual_intervention'],
            ['expired', 'blocked_manual_intervention'],
            ['verified', 'completed'],
            ['completed', 'completed'],
            ['partial', 'failed'],
            ['degraded', 'failed'],
            ['failed', 'failed'],
            ['cancelled', 'cancelled'],
        ];
        for (const [manifest, expected] of cases) {
            expect(mapTaskStatusToRuntimeStatus({ status: manifest } as any), `${manifest} → ${expected}`).toBe(expected);
        }
    });

    it('returns failed for null/undefined task', () => {
        expect(mapTaskStatusToRuntimeStatus(null)).toBe('failed');
        expect(mapTaskStatusToRuntimeStatus(undefined)).toBe('failed');
    });
});

describe('agent runtime — prompt generation', () => {
    it('builds runtime prompts with structured output instructions when a schema is provided', () => {
        const prompt = buildAgentRuntimeTaskDescription({
            role: 'script-generator',
            workspace_path: 'C:\\workspace',
            input: { topic: 'launch video' },
            skill: 'script-generation',
            output_schema: { type: 'object', required: ['title'] }
        });

        expect(prompt).toContain('script-generation');
        expect(prompt).toContain('Return ONLY valid JSON');
        expect(prompt).toContain('"topic": "launch video"');
    });

    it('builds prompts without JSON constraint when no output_schema is provided', () => {
        const prompt = buildAgentRuntimeTaskDescription({
            role: 'summarizer',
            workspace_path: '/workspace',
            input: { text: 'hello world' }
        });

        expect(prompt).not.toContain('Return ONLY valid JSON');
        expect(prompt).toContain('Prefer machine-readable JSON');
        expect(prompt).toContain('"text": "hello world"');
    });

    it('includes custom instructions in the prompt', () => {
        const prompt = buildAgentRuntimeTaskDescription({
            role: 'translator',
            workspace_path: '/workspace',
            input: { sentence: 'hello' },
            instructions: 'Translate to French. Use formal register.'
        });

        expect(prompt).toContain('Translate to French');
        expect(prompt).toContain('formal register');
    });

    it('includes role description in the prompt', () => {
        const prompt = buildAgentRuntimeTaskDescription({
            role: 'reviewer',
            workspace_path: '/workspace',
            input: {},
            role_description: 'Security auditing expert'
        });

        expect(prompt).toContain('Security auditing expert');
    });
});

describe('agent runtime — envelope construction', () => {
    it('builds a completed envelope with parsed JSON result', () => {
        const tmpDir = makeTmpDir();
        const outputPath = path.join(tmpDir, 'result.json');
        fs.writeFileSync(outputPath, JSON.stringify({ title: 'Hello', score: 42 }), 'utf8');

        const record = makeRecord({ output_path: outputPath });
        const task = makeTask({ output_path: outputPath, completed_at: Date.now() });

        const envelope = buildAgentRuntimeEnvelope(record, task);

        expect(envelope.status).toBe('completed');
        expect(envelope.result).toEqual({ title: 'Hello', score: 42 });
        expect(envelope.requires_manual_intervention).toBe(false);
        expect(envelope.error_code).toBeUndefined();
        expect(envelope.runtime_metadata.role).toBe('test-role');
        expect(envelope.runtime_metadata.retries_attempted).toBe(0);
    });

    it('returns raw text when output is not JSON', () => {
        const tmpDir = makeTmpDir();
        const outputPath = path.join(tmpDir, 'result.txt');
        fs.writeFileSync(outputPath, 'This is plain text output.', 'utf8');

        const record = makeRecord({ output_path: outputPath });
        const task = makeTask({ output_path: outputPath });

        const envelope = buildAgentRuntimeEnvelope(record, task);

        expect(envelope.status).toBe('completed');
        expect(envelope.result).toBe('This is plain text output.');
    });

    it('marks malformed structured output as failed even after worker completion', () => {
        const tmpDir = makeTmpDir();
        const outputPath = path.join(tmpDir, 'run_123.json');
        fs.writeFileSync(outputPath, '{not-json', 'utf8');

        const record = makeRecord({
            run_id: 'run_123',
            output_path: outputPath,
            output_schema: { type: 'object' }
        });

        const envelope = buildAgentRuntimeEnvelope(record, makeTask({
            taskId: 'run_123',
            output_path: outputPath
        }));

        expect(envelope.status).toBe('failed');
        expect(envelope.error_code).toBe('invalid_structured_output');
    });

    it('extracts JSON from markdown-wrapped structured output', () => {
        const tmpDir = makeTmpDir();
        const outputPath = path.join(tmpDir, 'run_md.json');
        fs.writeFileSync(outputPath, 'Info: result written.\n\n```json\n{"message": "pong"}\n```\n', 'utf8');

        const record = makeRecord({
            run_id: 'run_md',
            output_path: outputPath,
            output_schema: { type: 'object' }
        });

        const envelope = buildAgentRuntimeEnvelope(record, makeTask({
            taskId: 'run_md',
            output_path: outputPath
        }));

        expect(envelope.status).toBe('completed');
        expect(envelope.result).toEqual({ message: 'pong' });
    });

    it('extracts JSON from prose-wrapped braces', () => {
        const tmpDir = makeTmpDir();
        const outputPath = path.join(tmpDir, 'run_prose.json');
        fs.writeFileSync(outputPath, 'Here is the result:\n{"status": "ok", "count": 42}\nDone.', 'utf8');

        const record = makeRecord({
            run_id: 'run_prose',
            output_path: outputPath,
            output_schema: { type: 'object' }
        });

        const envelope = buildAgentRuntimeEnvelope(record, makeTask({
            taskId: 'run_prose',
            output_path: outputPath
        }));

        expect(envelope.status).toBe('completed');
        expect(envelope.result).toEqual({ status: 'ok', count: 42 });
    });

    it('marks missing output as failed with missing_output_artifact', () => {
        const record = makeRecord({ output_path: '/nonexistent/path.json' });
        const task = makeTask({ output_path: '/nonexistent/path.json' });

        const envelope = buildAgentRuntimeEnvelope(record, task);

        expect(envelope.status).toBe('failed');
        expect(envelope.error_code).toBe('missing_output_artifact');
    });

    it('sets requires_manual_intervention for awaiting_input tasks', () => {
        const record = makeRecord();
        const task = makeTask({
            status: 'awaiting_input',
            pause_question: 'Which database should I use?'
        });

        const envelope = buildAgentRuntimeEnvelope(record, task);

        expect(envelope.status).toBe('blocked_manual_intervention');
        expect(envelope.requires_manual_intervention).toBe(true);
        expect(envelope.action_required).toContain('Which database should I use?');
        expect(envelope.error_code).toBe('manual_intervention_required');
    });

    it('builds cancelled envelope', () => {
        const record = makeRecord();
        const task = makeTask({
            status: 'cancelled',
            cancellation_reason: 'User requested cancellation',
            cancelled_at: Date.now()
        });

        const envelope = buildAgentRuntimeEnvelope(record, task);

        expect(envelope.status).toBe('cancelled');
        expect(envelope.error_code).toBe('run_cancelled');
        expect(envelope.error_message).toContain('User requested cancellation');
    });

    it('includes engine/model/session metadata when available', () => {
        const tmpDir = makeTmpDir();
        const outputPath = path.join(tmpDir, 'result.json');
        fs.writeFileSync(outputPath, '{"ok":true}', 'utf8');

        const record = makeRecord({ output_path: outputPath, skill: 'classification' });
        const task = makeTask({
            output_path: outputPath,
            resolved_engine: 'claude-code',
            resolved_model: 'claude-opus-4.6-1m',
            session_id: 'sess_abc123',
            agent_id: 'classifier_abc12345'
        });

        const envelope = buildAgentRuntimeEnvelope(record, task);

        expect(envelope.runtime_metadata.engine).toBe('claude-code');
        expect(envelope.runtime_metadata.model).toBe('claude-opus-4.6-1m');
        expect(envelope.runtime_metadata.session_id).toBe('sess_abc123');
        expect(envelope.runtime_metadata.agent_id).toBe('classifier_abc12345');
        expect(envelope.runtime_metadata.skill).toBe('classification');
    });

    it('tracks retry history via retries_attempted', () => {
        const record = makeRecord({
            history: [
                { task_id: 'run_a', status: 'pending', at: '2026-03-22T00:00:00Z' },
                { task_id: 'run_b', status: 'pending', at: '2026-03-22T00:01:00Z', note: 'Retry 1' },
                { task_id: 'run_c', status: 'pending', at: '2026-03-22T00:02:00Z', note: 'Retry 2' }
            ]
        });

        const envelope = buildAgentRuntimeEnvelope(record, makeTask({ status: 'failed', error_message: 'timed out' }));

        expect(envelope.runtime_metadata.retries_attempted).toBe(2);
    });

    it('includes usage metadata when present in record', () => {
        const record = makeRecord({
            usage: { input_tokens: 1500, output_tokens: 320 }
        });
        const envelope = buildAgentRuntimeEnvelope(record, makeTask());
        expect(envelope.runtime_metadata.usage).toEqual({ input_tokens: 1500, output_tokens: 320 });
    });

    it('includes stop_reason when present in record', () => {
        const record = makeRecord({
            stop_reason: 'end_turn'
        });
        const envelope = buildAgentRuntimeEnvelope(record, makeTask());
        expect(envelope.runtime_metadata.stop_reason).toBe('end_turn');
    });

    it('omits usage and stop_reason when not set', () => {
        const record = makeRecord();
        const envelope = buildAgentRuntimeEnvelope(record, makeTask());
        expect(envelope.runtime_metadata.usage).toBeUndefined();
        expect(envelope.runtime_metadata.stop_reason).toBeUndefined();
    });
});

describe('agent runtime — record persistence', () => {
    it('saves and loads agent runtime records', () => {
        const tmpDir = makeTmpDir();
        const record = makeRecord({ run_id: 'persist_test' });

        saveAgentRuntimeRecord(tmpDir, record);
        const loaded = loadAgentRuntimeRecord(tmpDir, 'persist_test');

        expect(loaded).not.toBeNull();
        expect(loaded!.run_id).toBe('persist_test');
        expect(loaded!.request.role).toBe('test-role');
    });

    it('returns null for non-existent records', () => {
        const tmpDir = makeTmpDir();
        expect(loadAgentRuntimeRecord(tmpDir, 'nonexistent')).toBeNull();
    });

    it('appends history entries and updates timestamp', () => {
        const tmpDir = makeTmpDir();
        const record = makeRecord({ run_id: 'history_test' });
        saveAgentRuntimeRecord(tmpDir, record);

        const updated = appendAgentRuntimeHistory(tmpDir, 'history_test', {
            task_id: 'run_retry',
            status: 'pending',
            at: '2026-03-22T01:00:00.000Z',
            note: 'Retry after engine fallback'
        });

        expect(updated).not.toBeNull();
        expect(updated!.history).toHaveLength(2);
        expect(updated!.history[1].note).toBe('Retry after engine fallback');
        expect(updated!.updated_at).toBe('2026-03-22T01:00:00.000Z');

        const reloaded = loadAgentRuntimeRecord(tmpDir, 'history_test');
        expect(reloaded!.history).toHaveLength(2);
    });

    it('creates required directories via ensureAgentRuntimeDirectories', () => {
        const tmpDir = makeTmpDir();
        const { stateDir, outputDir } = ensureAgentRuntimeDirectories(tmpDir);

        expect(fs.existsSync(stateDir)).toBe(true);
        expect(fs.existsSync(outputDir)).toBe(true);
        expect(stateDir).toContain('agent-runtime');
        expect(outputDir).toContain('agent-runtime');
    });
});
