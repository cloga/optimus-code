import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWorkerLogFd } from '../mcp/council-runner';

describe('openWorkerLogFd', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns a numeric file descriptor for worker stderr logs', () => {
        const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-worker-log-'));

        const fd = openWorkerLogFd(logsDir, 'task123');

        expect(typeof fd).toBe('number');
        expect(fs.existsSync(path.join(logsDir, 'worker-task123.log'))).toBe(true);

        if (typeof fd === 'number') {
            fs.closeSync(fd);
        }

        fs.rmSync(logsDir, { recursive: true, force: true });
    });

    it('falls back to ignore when opening the log file fails', () => {
        vi.spyOn(fs, 'openSync').mockImplementation(() => {
            throw new Error('disk failure');
        });

        const logsDir = path.join(os.tmpdir(), 'optimus-worker-log-fail');
        const fd = openWorkerLogFd(logsDir, 'task123');

        expect(fd).toBe('ignore');
    });
});