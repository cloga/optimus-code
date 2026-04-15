import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAsyncDelegateTask, prepareAsyncPlanDispatch } from '../mcp/async-plan-dispatch';
import { TaskManifestManager } from '../managers/TaskManifestManager';

function createTempWorkspace(): string {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'async-plan-dispatch-'));
    fs.mkdirSync(path.join(workspace, '.optimus', 'config'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.optimus', 'state'), { recursive: true });
    return workspace;
}

function cleanup(workspace: string): void {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
}

describe('async plan dispatch helpers', () => {
    it('creates blocked async tasks when dependencies are unresolved', () => {
        const workspace = createTempWorkspace();
        try {
            TaskManifestManager.createTask(workspace, {
                taskId: 'dep_task',
                type: 'delegate_task',
                role: 'researcher',
                task_description: 'dependency task',
                task_artifact_path: path.join(workspace, '.optimus', 'tasks', 'dep_task.md'),
                output_path: path.join(workspace, '.optimus', 'results', 'dep_task.md'),
                workspacePath: workspace,
            });

            const created = createAsyncDelegateTask({
                role: 'builder',
                task_description: 'follow-up task',
                output_path: 'follow-up.md',
                workspace_path: workspace,
                depends_on: ['dep_task'],
                task_id: 'follow_up',
            });

            const manifest = TaskManifestManager.loadManifest(workspace);
            expect(created.blockedBy).toEqual(['dep_task']);
            expect(manifest.follow_up.status).toBe('blocked');
            expect(manifest.follow_up.blocked_by).toEqual(['dep_task']);
            expect(created.outputPath).toBe(path.join(workspace, '.optimus', 'results', 'follow-up.md'));
        } finally {
            cleanup(workspace);
        }
    });

    it('maps plan-local dependency ids to generated task ids and spawns only ready tasks', () => {
        const workspace = createTempWorkspace();
        try {
            const prepared = prepareAsyncPlanDispatch({
                workspacePath: workspace,
                items: [
                    {
                        id: 'design',
                        role: 'architect',
                        task_description: 'Create the design',
                        output_path: 'design.md',
                    },
                    {
                        id: 'implement',
                        role: 'dev',
                        task_description: 'Implement the design',
                        output_path: 'implement.md',
                        depends_on: ['design'],
                    },
                ],
                planId: 'plan_test',
            });

            expect(prepared.readyTaskIds).toEqual(['plan_test__design']);
            expect(prepared.blockedTaskIds).toEqual(['plan_test__implement']);
            expect(prepared.itemTaskIds).toEqual({
                design: 'plan_test__design',
                implement: 'plan_test__implement',
            });

            const manifest = TaskManifestManager.loadManifest(workspace);
            expect(manifest['plan_test__design'].status).toBe('pending');
            expect(manifest['plan_test__implement'].status).toBe('blocked');
            expect(manifest['plan_test__implement'].depends_on).toEqual(['plan_test__design']);
            expect(manifest['plan_test__implement'].blocked_by).toEqual(['plan_test__design']);
        } finally {
            cleanup(workspace);
        }
    });

    it('allows dependencies to point at existing verified tasks', () => {
        const workspace = createTempWorkspace();
        try {
            TaskManifestManager.createTask(workspace, {
                taskId: 'verified_task',
                type: 'delegate_task',
                role: 'researcher',
                task_description: 'done already',
                task_artifact_path: path.join(workspace, '.optimus', 'tasks', 'verified_task.md'),
                output_path: path.join(workspace, '.optimus', 'results', 'verified_task.md'),
                workspacePath: workspace,
            });
            const manifest = TaskManifestManager.loadManifest(workspace);
            manifest.verified_task.status = 'verified';
            TaskManifestManager.saveManifest(workspace, manifest);

            const prepared = prepareAsyncPlanDispatch({
                workspacePath: workspace,
                items: [
                    {
                        id: 'followup',
                        role: 'dev',
                        task_description: 'Use existing verified dependency',
                        output_path: 'followup.md',
                        depends_on: ['verified_task'],
                    },
                ],
                planId: 'plan_verified',
            });

            expect(prepared.readyTaskIds).toEqual(['plan_verified__followup']);
            expect(prepared.blockedTaskIds).toEqual([]);
            const finalManifest = TaskManifestManager.loadManifest(workspace);
            expect(finalManifest['plan_verified__followup'].status).toBe('pending');
            expect(finalManifest['plan_verified__followup'].depends_on).toEqual(['verified_task']);
        } finally {
            cleanup(workspace);
        }
    });
});
