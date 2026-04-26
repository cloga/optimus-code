import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    MetaCronEngine,
    loadCrontab,
    persistCronEntryRunning,
    reconcileCrontabFromManifest,
    saveCrontab,
    updateCronEntryFromTask,
} from '../mcp/meta-cron-engine';

function getLeaderLockPath(workspacePath: string): string {
    return path.join(workspacePath, '.optimus', 'system', 'cron-locks', 'scheduler-leader.lock');
}

describe('Meta-Cron engine workspace scoping', () => {
    let rootDir: string;
    let workspaceOne: string;
    let workspaceTwo: string;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cron-engine-test-'));
        workspaceOne = path.join(rootDir, 'workspace-one');
        workspaceTwo = path.join(rootDir, 'workspace-two');
        fs.mkdirSync(workspaceOne, { recursive: true });
        fs.mkdirSync(workspaceTwo, { recursive: true });
    });

    afterEach(() => {
        MetaCronEngine.shutdown();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it('tracks scheduler leadership per workspace and cleans up all locks on shutdown', () => {
        MetaCronEngine.init(workspaceOne);
        MetaCronEngine.init(workspaceTwo);

        const workspaceOneLock = getLeaderLockPath(workspaceOne);
        const workspaceTwoLock = getLeaderLockPath(workspaceTwo);

        expect(fs.existsSync(workspaceOneLock)).toBe(true);
        expect(fs.existsSync(workspaceTwoLock)).toBe(true);

        MetaCronEngine.shutdown();

        expect(fs.existsSync(workspaceOneLock)).toBe(false);
        expect(fs.existsSync(workspaceTwoLock)).toBe(false);
    });

    it('can shut down one workspace without affecting another scheduler', () => {
        MetaCronEngine.init(workspaceOne);
        MetaCronEngine.init(workspaceTwo);

        const workspaceOneLock = getLeaderLockPath(workspaceOne);
        const workspaceTwoLock = getLeaderLockPath(workspaceTwo);

        MetaCronEngine.shutdown(workspaceOne);

        expect(fs.existsSync(workspaceOneLock)).toBe(false);
        expect(fs.existsSync(workspaceTwoLock)).toBe(true);
    });

    it('persists running state immediately when a cron entry fires', () => {
        const crontab = {
            max_concurrent: 1,
            crons: [{
                id: 'focus-video-weekly-refresh',
                cron_expression: '17 17 * * 5',
                role: 'script-agent',
                required_skills: [],
                capability_tier: 'maintain',
                concurrency_policy: 'Forbid',
                max_actions: 1,
                dry_run_remaining: 0,
                enabled: true,
                last_run: null,
                last_status: null,
                run_count: 7,
                fail_count: 3,
                created_at: '2026-04-01T00:00:00.000Z',
            }],
        };

        persistCronEntryRunning(workspaceOne, crontab, crontab.crons[0], new Date('2026-04-24T09:17:00.000Z'));

        const saved = loadCrontab(workspaceOne)!;
        expect(saved.crons[0].last_run).toBe('2026-04-24T09:17:00.000Z');
        expect(saved.crons[0].last_status).toBe('running');
        expect(saved.crons[0].run_count).toBe(8);
        expect(saved.crons[0].fail_count).toBe(3);
    });

    it('writes terminal failure metadata back to the cron entry', () => {
        saveCrontab(workspaceOne, {
            max_concurrent: 1,
            crons: [{
                id: 'focus-video-weekly-refresh',
                cron_expression: '17 17 * * 5',
                role: 'script-agent',
                required_skills: [],
                capability_tier: 'maintain',
                concurrency_policy: 'Forbid',
                max_actions: 1,
                dry_run_remaining: 0,
                enabled: true,
                last_run: '2026-04-12T22:17:28.399Z',
                last_status: 'verified',
                run_count: 7,
                fail_count: 3,
                created_at: '2026-04-01T00:00:00.000Z',
            }],
        });

        updateCronEntryFromTask(workspaceOne, 'focus-video-weekly-refresh', {
            taskId: 'cron_focus-video-weekly-refresh_1777022254150_6uk27u',
            status: 'failed',
            startTime: Date.parse('2026-04-24T09:17:34.150Z'),
            heartbeatTime: Date.parse('2026-04-24T09:18:34.150Z'),
            agent_id: 'script-agent_abc123',
            cron_run_number: 8,
            error_message: 'Worker execution failed for role script-agent on engine github-copilot: auth_failed - ACP auth_failed: Authentication required. Fix: for Copilot ACP run `gh auth login`.',
            failure_classification: 'infrastructure_failure',
        }, { incrementFailure: true });

        const saved = loadCrontab(workspaceOne)!;
        const entry = saved.crons[0];
        expect(entry.last_run).toBe('2026-04-24T09:17:34.150Z');
        expect(entry.last_status).toBe('failed');
        expect(entry.run_count).toBe(8);
        expect(entry.fail_count).toBe(4);
        expect(entry.last_agent_id).toBe('script-agent_abc123');
        expect(entry.last_failure_code).toBe('auth_failed');
        expect(entry.last_failure_fix).toContain('gh auth login');
        expect(entry.last_heartbeat_at).toBe('2026-04-24T09:18:34.150Z');
    });

    it('reconciles stale crontab status from newer terminal cron tasks in the manifest', () => {
        saveCrontab(workspaceOne, {
            max_concurrent: 1,
            crons: [{
                id: 'focus-video-weekly-refresh',
                cron_expression: '17 17 * * 5',
                role: 'script-agent',
                required_skills: [],
                capability_tier: 'maintain',
                concurrency_policy: 'Forbid',
                max_actions: 1,
                dry_run_remaining: 0,
                enabled: true,
                last_run: '2026-04-12T22:17:28.399Z',
                last_status: 'verified',
                run_count: 7,
                fail_count: 3,
                created_at: '2026-04-01T00:00:00.000Z',
            }],
        });
        const stateDir = path.join(workspaceOne, '.optimus', 'state');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'task-manifest.json'), JSON.stringify({
            'cron_focus-video-weekly-refresh_1777022254150_6uk27u': {
                taskId: 'cron_focus-video-weekly-refresh_1777022254150_6uk27u',
                type: 'delegate_task',
                role: 'script-agent',
                status: 'failed',
                startTime: Date.parse('2026-04-24T09:17:34.150Z'),
                heartbeatTime: Date.parse('2026-04-24T09:18:34.150Z'),
                completed_at: Date.parse('2026-04-24T09:18:35.000Z'),
                workspacePath: workspaceOne,
                cron_id: 'focus-video-weekly-refresh',
                cron_run_number: 8,
                error_message: 'Worker execution failed: task_timeout - ACP task_timeout: no activity from engine for 306s (limit: 300s). Fix: increase timeout via runtime_policy.timeout_ms.',
                failure_classification: 'heartbeat_timeout',
            },
        }, null, 2), 'utf8');

        expect(reconcileCrontabFromManifest(workspaceOne)).toBe(true);

        const saved = loadCrontab(workspaceOne)!;
        const entry = saved.crons[0];
        expect(entry.last_run).toBe('2026-04-24T09:17:34.150Z');
        expect(entry.last_status).toBe('failed');
        expect(entry.run_count).toBe(8);
        expect(entry.fail_count).toBe(4);
        expect(entry.last_failure_code).toBe('task_timeout');
        expect(entry.last_activity_timeout_ms).toBe(300000);
    });
});
