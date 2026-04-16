import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskManifestManager } from '../managers/TaskManifestManager';

function createTempWorkspace(): string {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'task-manifest-manager-'));
    fs.mkdirSync(path.join(workspace, '.optimus', 'config'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.optimus', 'state'), { recursive: true });
    return workspace;
}

function cleanup(workspace: string): void {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
}

describe('TaskManifestManager dependency healing', () => {
    it('fails blocked tasks when a dependency fails terminally', () => {
        const workspace = createTempWorkspace();
        try {
            TaskManifestManager.createTask(workspace, {
                taskId: 'dep_task',
                type: 'delegate_task',
                role: 'dev',
                task_description: 'upstream',
                task_artifact_path: path.join(workspace, '.optimus', 'tasks', 'dep_task.md'),
                output_path: path.join(workspace, '.optimus', 'results', 'dep_task.md'),
                workspacePath: workspace,
            });
            TaskManifestManager.createTask(workspace, {
                taskId: 'blocked_task',
                type: 'delegate_task',
                role: 'qa-engineer',
                task_description: 'downstream',
                task_artifact_path: path.join(workspace, '.optimus', 'tasks', 'blocked_task.md'),
                output_path: path.join(workspace, '.optimus', 'results', 'blocked_task.md'),
                workspacePath: workspace,
                depends_on: ['dep_task'],
                blocked_by: ['dep_task'],
            });

            const manifest = TaskManifestManager.loadManifest(workspace);
            manifest.dep_task.status = 'failed';
            manifest.dep_task.error_message = 'boom';
            manifest.blocked_task.status = 'blocked';
            TaskManifestManager.saveManifest(workspace, manifest);

            TaskManifestManager.reapStaleTasks(workspace);

            const healed = TaskManifestManager.loadManifest(workspace);
            expect(healed.blocked_task.status).toBe('failed');
            expect(healed.blocked_task.failure_classification).toBe('dependency_failed');
            expect(healed.blocked_task.error_message).toContain('dep_task (failed)');
            expect(healed.blocked_task.blocked_by).toBeUndefined();
            expect(typeof healed.blocked_task.completed_at).toBe('number');
        } finally {
            cleanup(workspace);
        }
    });

    it('fails blocked tasks when a dependency record is missing', () => {
        const workspace = createTempWorkspace();
        try {
            TaskManifestManager.createTask(workspace, {
                taskId: 'blocked_task',
                type: 'delegate_task',
                role: 'qa-engineer',
                task_description: 'downstream',
                task_artifact_path: path.join(workspace, '.optimus', 'tasks', 'blocked_task.md'),
                output_path: path.join(workspace, '.optimus', 'results', 'blocked_task.md'),
                workspacePath: workspace,
                depends_on: ['missing_task'],
                blocked_by: ['missing_task'],
            });

            const manifest = TaskManifestManager.loadManifest(workspace);
            manifest.blocked_task.status = 'blocked';
            TaskManifestManager.saveManifest(workspace, manifest);

            TaskManifestManager.reapStaleTasks(workspace);

            const healed = TaskManifestManager.loadManifest(workspace);
            expect(healed.blocked_task.status).toBe('failed');
            expect(healed.blocked_task.failure_classification).toBe('dependency_missing');
            expect(healed.blocked_task.error_message).toContain('missing_task');
        } finally {
            cleanup(workspace);
        }
    });

    it('promotes blocked tasks to pending when dependencies are already verified', () => {
        const workspace = createTempWorkspace();
        try {
            TaskManifestManager.createTask(workspace, {
                taskId: 'verified_task',
                type: 'delegate_task',
                role: 'dev',
                task_description: 'upstream',
                task_artifact_path: path.join(workspace, '.optimus', 'tasks', 'verified_task.md'),
                output_path: path.join(workspace, '.optimus', 'results', 'verified_task.md'),
                workspacePath: workspace,
            });
            TaskManifestManager.createTask(workspace, {
                taskId: 'blocked_task',
                type: 'delegate_task',
                role: 'qa-engineer',
                task_description: 'downstream',
                task_artifact_path: path.join(workspace, '.optimus', 'tasks', 'blocked_task.md'),
                output_path: path.join(workspace, '.optimus', 'results', 'blocked_task.md'),
                workspacePath: workspace,
                depends_on: ['verified_task'],
                blocked_by: ['verified_task'],
            });

            const manifest = TaskManifestManager.loadManifest(workspace);
            manifest.verified_task.status = 'verified';
            manifest.blocked_task.status = 'blocked';
            TaskManifestManager.saveManifest(workspace, manifest);

            TaskManifestManager.reapStaleTasks(workspace);

            const healed = TaskManifestManager.loadManifest(workspace);
            expect(healed.blocked_task.status).toBe('pending');
            expect(healed.blocked_task.blocked_by).toBeUndefined();
        } finally {
            cleanup(workspace);
        }
    });
});
