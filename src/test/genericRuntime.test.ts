import fs from 'fs';
import { afterEach, describe, it, expect } from 'vitest';
import path from 'path';
import {
    runGenericSync,
    startGenericRun,
    getGenericRunStatus,
    cancelGenericRun,
    listGenericEngines,
    getGenericEngineDiagnostics,
    buildGenericHealthPayload,
} from '../runtime/genericRuntime';
import { buildOptimusStatusSnapshot } from '../mcp/mcp-server';

const createdPaths = new Set<string>();
const ORIGINAL_USER_CONFIG_PATH = process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;

function createProjectTempDir(prefix: string): string {
    const parent = path.join(process.cwd(), '.optimus');
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, prefix));
    createdPaths.add(dir);
    return dir;
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function createWorkspace(): string {
    const workspacePath = createProjectTempDir('test-diagnostics-workspace-');
    fs.mkdirSync(path.join(workspacePath, '.optimus', 'config'), { recursive: true });
    return workspacePath;
}

function configureUserEngines(engines: Record<string, unknown>): void {
    const configPath = path.join(createProjectTempDir('test-diagnostics-user-config-'), 'available-agents.json');
    writeJson(configPath, { engines });
    process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = configPath;
}

afterEach(() => {
    if (ORIGINAL_USER_CONFIG_PATH === undefined) {
        delete process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH;
    } else {
        process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH = ORIGINAL_USER_CONFIG_PATH;
    }
    for (const targetPath of createdPaths) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
    createdPaths.clear();
});

describe('genericRuntime', () => {
    describe('listGenericEngines', () => {
        it('returns available engines', () => {
            const engines = listGenericEngines();
            expect(engines.length).toBeGreaterThan(0);
            expect(engines).toContain('github-copilot');
        });

        it('includes configured workspace engines when workspace_path is available', () => {
            const workspacePath = createWorkspace();
            configureUserEngines({
                'qwen-code': {
                    protocol: 'acp',
                    available_models: ['qwen3-coder'],
                    acp: { path: 'qwen' },
                },
            });

            const diagnostics = getGenericEngineDiagnostics(workspacePath);

            expect(diagnostics.builtin_engines).toContain('github-copilot');
            expect(diagnostics.configured_engines).toContain('qwen-code');
            expect(diagnostics.engines).toContain('qwen-code');
        });
    });

    describe('optimus status diagnostics', () => {
        it('counts user-level engines through the resolved available-agents config', () => {
            const workspacePath = createWorkspace();
            fs.writeFileSync(path.join(workspacePath, '.optimus', 'config', 'system-instructions.md'), '# test', 'utf8');
            configureUserEngines({
                'qwen-code': {
                    protocol: 'acp',
                    available_models: ['qwen3-coder'],
                    acp: { path: 'qwen' },
                },
            });

            const status = buildOptimusStatusSnapshot(workspacePath);

            expect(status.active).toBe(true);
            expect(status.engines).toBeGreaterThan(0);
            expect(status.configured_engines).toContain('qwen-code');
        });
    });

    describe('generic health diagnostics', () => {
        it('keeps engines as an array and adds configured/builtin engine fields', () => {
            const workspacePath = createWorkspace();
            configureUserEngines({
                'qwen-code': {
                    protocol: 'acp',
                    available_models: ['qwen3-coder'],
                    acp: { path: 'qwen' },
                },
            });

            const payload = buildGenericHealthPayload('test-version', 123, workspacePath);

            expect(Array.isArray(payload.engines)).toBe(true);
            expect(payload.builtin_engines).toContain('github-copilot');
            expect(payload.configured_engines).toContain('qwen-code');
            expect(payload.engines).toContain('qwen-code');
            expect(payload.workspace).toBe(path.resolve(process.cwd()));
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
