import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLock, deleteLock, isLocked, updateLockPid, getLockPath, getLockDir } from '../mcp/meta-cron-engine';

describe('Meta-Cron lock management (Issue #511)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cron-test-'));
        const lockDir = path.join(tmpDir, '.optimus', 'system', 'cron-locks');
        fs.mkdirSync(lockDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('createLock succeeds on first call and blocks on second call', () => {
        expect(createLock(tmpDir, 'test-job')).toBe(true);
        // Second call should fail — lock already held
        expect(createLock(tmpDir, 'test-job')).toBe(false);
    });

    it('deleteLock allows createLock to succeed again', () => {
        expect(createLock(tmpDir, 'test-job')).toBe(true);
        deleteLock(tmpDir, 'test-job');
        // After delete, should succeed again
        expect(createLock(tmpDir, 'test-job')).toBe(true);
    });

    it('isLocked returns true when lock is held by current process', () => {
        createLock(tmpDir, 'test-job');
        expect(isLocked(tmpDir, 'test-job')).toBe(true);
    });

    it('isLocked returns false when no lock exists', () => {
        expect(isLocked(tmpDir, 'test-job')).toBe(false);
    });

    it('createLock treats lock with dead PID as stale and reclaims it', () => {
        // Write a lock file with a PID that definitely doesn't exist
        const lockPath = getLockPath(tmpDir, 'test-job');
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: 2147483647, // max 32-bit PID — almost certainly not running
            locked_at: new Date().toISOString(),
        }), 'utf8');

        // createLock should detect the dead PID, remove the stale lock, and succeed
        expect(createLock(tmpDir, 'test-job')).toBe(true);
    });

    it('createLock does NOT treat lock with alive PID as stale', () => {
        // Write a lock file with the current process PID (alive)
        const lockPath = getLockPath(tmpDir, 'test-job');
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: process.pid,
            locked_at: new Date().toISOString(),
        }), 'utf8');

        // Should fail — current process PID is alive, lock is valid
        expect(createLock(tmpDir, 'test-job')).toBe(false);
    });

    it('updateLockPid changes the PID in the lock file', () => {
        createLock(tmpDir, 'test-job');
        const lockPath = getLockPath(tmpDir, 'test-job');

        // Verify initial PID is current process
        const before = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        expect(before.pid).toBe(process.pid);

        // Update to a different PID
        updateLockPid(tmpDir, 'test-job', 99999);
        const after = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        expect(after.pid).toBe(99999);
        // locked_at should be preserved
        expect(after.locked_at).toBe(before.locked_at);
    });

    it('lock with expired time-based threshold (2h) is treated as stale', () => {
        const lockPath = getLockPath(tmpDir, 'test-job');
        // Write a lock that's 3 hours old with an alive PID
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: process.pid,
            locked_at: threeHoursAgo,
        }), 'utf8');

        // Should succeed — lock is older than 2h staleness threshold
        expect(createLock(tmpDir, 'test-job')).toBe(true);
    });

    it('lock within 2h time-based threshold is NOT treated as stale', () => {
        const lockPath = getLockPath(tmpDir, 'test-job');
        // Write a lock that's 90 minutes old with an alive PID
        const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: process.pid,
            locked_at: ninetyMinAgo,
        }), 'utf8');

        // Should fail — lock is within 2h threshold and PID is alive
        expect(createLock(tmpDir, 'test-job')).toBe(false);
    });
});
