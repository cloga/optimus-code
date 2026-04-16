import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { appendPlanAudit, readPlanAuditEntries, getPlanAuditLogPath } from '../mcp/plan-audit-log';
import type { OptimusDispatchPlan } from '../mcp/optimus-orchestrator';

function makePlan(overrides: Partial<OptimusDispatchPlan> = {}): OptimusDispatchPlan {
    return {
        strategy: 'delegate',
        rationale: ['test rationale'],
        summaryOutputPath: '.optimus/results/test.md',
        delegateSpec: {
            role: 'dev',
            task_description: 'do the thing',
            output_path: '.optimus/results/test.md',
            context_files: [],
        },
        ...overrides,
    };
}

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-audit-test-'));
}

describe('plan-audit-log', () => {
    it('appends a dispatched entry with canonical shape', async () => {
        const dir = mkTmp();
        try {
            await appendPlanAudit({
                workspacePath: dir,
                plan: makePlan(),
                plannerMode: 'code',
                taskDescription: 'implement feature X',
                taskIds: ['task_1'],
                parentIssueNumber: 42,
                dispatchOutcome: 'dispatched',
            });

            const entries = readPlanAuditEntries(dir);
            expect(entries).toHaveLength(1);
            const entry = entries[0];
            expect(entry.strategy).toBe('delegate');
            expect(entry.planner_mode).toBe('code');
            expect(entry.task_ids).toEqual(['task_1']);
            expect(entry.parent_issue_number).toBe(42);
            expect(entry.dispatch_outcome).toBe('dispatched');
            expect(entry.fanout).toBe(1);
            expect(entry.task_description_preview).toBe('implement feature X');
            expect(entry.rationale).toEqual(['test rationale']);
            expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('records fanout for council and plan strategies', async () => {
        const dir = mkTmp();
        try {
            await appendPlanAudit({
                workspacePath: dir,
                plan: makePlan({
                    strategy: 'council',
                    delegateSpec: undefined,
                    councilSpec: {
                        proposalPath: 'x.md',
                        proposalContent: '',
                        roles: ['a', 'b', 'c'],
                    },
                }),
                plannerMode: 'agent',
                taskDescription: 'council review',
                taskIds: ['council_1'],
                dispatchOutcome: 'dispatched',
            });
            await appendPlanAudit({
                workspacePath: dir,
                plan: makePlan({
                    strategy: 'plan',
                    delegateSpec: undefined,
                    planSpec: {
                        items: [
                            { id: 'a', role: 'dev', task_description: 't', output_path: 'o.md' },
                            { id: 'b', role: 'dev', task_description: 't', output_path: 'o.md' },
                        ] as any,
                    },
                }),
                plannerMode: 'code',
                taskDescription: 'multi-step',
                taskIds: ['t1', 't2'],
                dispatchOutcome: 'dispatched',
            });

            const entries = readPlanAuditEntries(dir);
            expect(entries.map(e => e.fanout)).toEqual([3, 2]);
            expect(entries.map(e => e.strategy)).toEqual(['council', 'plan']);
            expect(entries[0].planner_mode).toBe('agent');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('captures dispatch failure', async () => {
        const dir = mkTmp();
        try {
            await appendPlanAudit({
                workspacePath: dir,
                plan: makePlan(),
                plannerMode: 'code',
                taskDescription: 'broken dispatch',
                taskIds: [],
                dispatchOutcome: 'failed',
                errorMessage: 'engine unavailable',
            });
            const entries = readPlanAuditEntries(dir);
            expect(entries[0].dispatch_outcome).toBe('failed');
            expect(entries[0].task_ids).toEqual([]);
            expect(entries[0].error_message).toBe('engine unavailable');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('truncates long task descriptions in preview', async () => {
        const dir = mkTmp();
        try {
            const long = 'a '.repeat(500);
            await appendPlanAudit({
                workspacePath: dir,
                plan: makePlan(),
                plannerMode: 'code',
                taskDescription: long,
                taskIds: ['t'],
                dispatchOutcome: 'dispatched',
            });
            const entries = readPlanAuditEntries(dir);
            expect(entries[0].task_description_preview.length).toBeLessThanOrEqual(201);
            expect(entries[0].task_description_preview.endsWith('…')).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('skips corrupt lines when reading', async () => {
        const dir = mkTmp();
        try {
            const logPath = getPlanAuditLogPath(dir);
            fs.appendFileSync(logPath, 'not-json\n');
            await appendPlanAudit({
                workspacePath: dir,
                plan: makePlan(),
                plannerMode: 'code',
                taskDescription: 'ok',
                taskIds: ['t'],
                dispatchOutcome: 'dispatched',
            });
            fs.appendFileSync(logPath, '{bad\n');
            const entries = readPlanAuditEntries(dir);
            expect(entries).toHaveLength(1);
            expect(entries[0].task_description_preview).toBe('ok');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('serializes concurrent appends without truncation', async () => {
        const dir = mkTmp();
        try {
            const N = 20;
            await Promise.all(
                Array.from({ length: N }, (_, i) => appendPlanAudit({
                    workspacePath: dir,
                    plan: makePlan(),
                    plannerMode: 'code',
                    taskDescription: `task ${i}`,
                    taskIds: [`t${i}`],
                    dispatchOutcome: 'dispatched',
                }))
            );
            const entries = readPlanAuditEntries(dir);
            expect(entries).toHaveLength(N);
            const previews = entries.map(e => e.task_description_preview).sort();
            expect(previews).toContain('task 0');
            expect(previews).toContain('task 19');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
