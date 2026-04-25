import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildOptimusDispatchPlan, resolveEffectiveTaskStatus, summarizeOptimusTaskSettlement } from '../mcp/optimus-orchestrator';
import type { TaskRecord } from '../managers/TaskManifestManager';

function createTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
        taskId: overrides.taskId || 'task_1',
        type: overrides.type || 'delegate_task',
        status: overrides.status || 'completed',
        startTime: overrides.startTime || Date.now(),
        heartbeatTime: overrides.heartbeatTime || Date.now(),
        workspacePath: overrides.workspacePath || process.cwd(),
        ...overrides,
    };
}

describe('optimus orchestrator settlement helpers', () => {
    it('treats completed tasks with materialized output as verified', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-orchestrator-'));
        try {
            const outputPath = path.join(workspace, 'result.txt');
            fs.writeFileSync(outputPath, 'done', 'utf8');

            expect(resolveEffectiveTaskStatus(createTaskRecord({ output_path: outputPath }))).toBe('verified');
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('marks missing or failed tasks as terminal failures in aggregate settlement', () => {
        const settlement = summarizeOptimusTaskSettlement(['implement', 'verify'], {
            implement: createTaskRecord({ taskId: 'implement', status: 'failed', error_message: 'boom' }),
        });

        expect(settlement.settled).toBe(true);
        expect(settlement.overallStatus).toBe('failed');
        expect(settlement.tasks.find(task => task.taskId === 'verify')?.effectiveStatus).toBe('missing');
    });

    it('marks mixed verified and awaiting-input tasks as awaiting_input terminal state', () => {
        const settlement = summarizeOptimusTaskSettlement(['implement', 'verify'], {
            implement: createTaskRecord({ taskId: 'implement', status: 'verified' }),
            verify: createTaskRecord({ taskId: 'verify', status: 'awaiting_input', pause_question: 'Need approval?' }),
        });

        expect(settlement.settled).toBe(true);
        expect(settlement.overallStatus).toBe('awaiting_input');
    });

    it('keeps the aggregate unsettled while any task is still pending or running', () => {
        const settlement = summarizeOptimusTaskSettlement(['implement', 'verify'], {
            implement: createTaskRecord({ taskId: 'implement', status: 'verified' }),
            verify: createTaskRecord({ taskId: 'verify', status: 'running' }),
        });

        expect(settlement.settled).toBe(false);
        expect(settlement.overallStatus).toBe('running');
    });
});

describe('optimus orchestrator planner role metadata', () => {
    it('adds role descriptions to delegate specs when selected roles are not registered', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: process.cwd(),
            outputPath: '.optimus/results/docs-delegate.md',
            taskDescription: 'Document how fleet role fallback works.',
            modeHint: 'delegate',
            registeredRoles: [],
            intentSignals: {
                wantsDocs: true,
                wantsImplementation: false,
                looksMultiStep: false,
            },
        });

        expect(plan.strategy).toBe('delegate');
        expect(plan.delegateSpec?.role).toBe('documentation-specialist');
        expect(plan.delegateSpec?.role_description).toContain('Documentation specialist');
    });

    it('adds role descriptions to every plan item when selected roles are not registered', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: process.cwd(),
            outputPath: '.optimus/results/security-plan.md',
            taskDescription: 'Investigate the security issue, implement a fix, and verify the regression tests.',
            modeHint: 'plan',
            registeredRoles: [],
            intentSignals: {
                wantsImplementation: true,
                wantsVerification: true,
                wantsArchitecture: true,
                wantsResearch: true,
                wantsSecurity: true,
                looksMultiStep: true,
            },
        });

        expect(plan.strategy).toBe('plan');
        expect(plan.planSpec?.items.length).toBeGreaterThan(0);
        for (const item of plan.planSpec?.items || []) {
            expect(item.role).toEqual(expect.stringMatching(/\S/));
            expect(item.role_description).toEqual(expect.stringMatching(/\S/));
        }

        const design = plan.planSpec?.items.find(item => item.id === 'design');
        expect(design?.role).toBe('security');
        expect(design?.role_description).toContain('Security engineer');
    });

    it('preserves known role preference while keeping security design roles describable', () => {
        const registeredRoles = [
            { canonical: 'architect', aliases: [] },
            { canonical: 'dev', aliases: [] },
            { canonical: 'qa-engineer', aliases: [] },
        ];
        const knownRoleNames = new Set(registeredRoles.flatMap(role => [role.canonical, ...role.aliases]));

        const plan = buildOptimusDispatchPlan({
            workspacePath: process.cwd(),
            outputPath: '.optimus/results/known-security-plan.md',
            taskDescription: 'Security-sensitive implementation that needs architecture analysis and verification.',
            modeHint: 'plan',
            registeredRoles,
            intentSignals: {
                wantsImplementation: true,
                wantsVerification: true,
                wantsArchitecture: true,
                wantsSecurity: true,
                looksMultiStep: true,
            },
        });

        const design = plan.planSpec?.items.find(item => item.id === 'design');
        expect(design?.role).toBe('architect');
        expect(knownRoleNames.has(design?.role || '')).toBe(true);
        expect(design?.role_description).toEqual(expect.stringMatching(/\S/));
        expect(design?.role_description).toContain('Software architect');
    });
});
