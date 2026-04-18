import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MetaCronEngine } from '../mcp/meta-cron-engine';

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
});
