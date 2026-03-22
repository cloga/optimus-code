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

    it('createLock writes cronId to the lock file', () => {
        createLock(tmpDir, 'hourly-patrol');
        const lockPath = getLockPath(tmpDir, 'hourly-patrol');
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        expect(data.cronId).toBe('hourly-patrol');
        expect(data.pid).toBe(process.pid);
        expect(data.locked_at).toBeDefined();
    });

    it('lock with dead server PID is NOT stale when manifest shows running task with fresh heartbeat (server-crash scenario)', () => {
        // Simulate: MCP server (PID 2147483647) created the lock and spawned a child.
        // The server died, but the child worker is still running and heartbeating in the manifest.
        const lockPath = getLockPath(tmpDir, 'hourly-patrol');
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: 2147483647, // dead server PID
            cronId: 'hourly-patrol',
            locked_at: new Date().toISOString(),
        }), 'utf8');

        // Create a manifest with a running task that has a fresh heartbeat
        const manifestDir = path.join(tmpDir, '.optimus', 'state');
        fs.mkdirSync(manifestDir, { recursive: true });
        const manifestPath = path.join(manifestDir, 'task-manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            'cron_hourly-patrol_1234_abc': {
                taskId: 'cron_hourly-patrol_1234_abc',
                status: 'running',
                heartbeatTime: Date.now() - 30_000, // 30 seconds ago — fresh
                startTime: Date.now() - 600_000,
            }
        }), 'utf8');

        // createLock should see the manifest entry and refuse to reclaim the lock
        expect(createLock(tmpDir, 'hourly-patrol')).toBe(false);
        // isLocked should return true — the worker is still running
        expect(isLocked(tmpDir, 'hourly-patrol')).toBe(true);
    });

    it('lock with dead server PID IS stale when manifest shows no running tasks', () => {
        const lockPath = getLockPath(tmpDir, 'hourly-patrol');
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: 2147483647, // dead PID
            cronId: 'hourly-patrol',
            locked_at: new Date().toISOString(),
        }), 'utf8');

        // Create a manifest with NO running tasks for this cron entry
        const manifestDir = path.join(tmpDir, '.optimus', 'state');
        fs.mkdirSync(manifestDir, { recursive: true });
        const manifestPath = path.join(manifestDir, 'task-manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            'cron_hourly-patrol_1234_abc': {
                taskId: 'cron_hourly-patrol_1234_abc',
                status: 'completed',
                heartbeatTime: Date.now() - 30_000,
                startTime: Date.now() - 600_000,
            }
        }), 'utf8');

        // createLock should detect dead PID + no running tasks = stale
        expect(createLock(tmpDir, 'hourly-patrol')).toBe(true);
    });

    it('lock with dead server PID IS stale when manifest task heartbeat is older than 5 minutes', () => {
        const lockPath = getLockPath(tmpDir, 'hourly-patrol');
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: 2147483647, // dead PID
            cronId: 'hourly-patrol',
            locked_at: new Date().toISOString(),
        }), 'utf8');

        // Create a manifest with a running task BUT stale heartbeat (>5 min old)
        const manifestDir = path.join(tmpDir, '.optimus', 'state');
        fs.mkdirSync(manifestDir, { recursive: true });
        const manifestPath = path.join(manifestDir, 'task-manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            'cron_hourly-patrol_1234_abc': {
                taskId: 'cron_hourly-patrol_1234_abc',
                status: 'running',
                heartbeatTime: Date.now() - 10 * 60 * 1000, // 10 min ago — stale
                startTime: Date.now() - 600_000,
            }
        }), 'utf8');

        // createLock should fall through to PID check — dead PID = stale
        expect(createLock(tmpDir, 'hourly-patrol')).toBe(true);
    });
});
