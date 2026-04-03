import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    memoryAgeDays,
    memoryFreshnessWarning,
    checkMemorySnapshot,
    initializeFromSnapshot,
} from '../managers/MemoryManager.js';
import {
    rejectNullBytes,
    rejectUrlEncodedTraversal,
    rejectUnicodeTraversal,
    normalizeCaseForComparison,
    validatePathSecurity,
} from '../utils/pathSecurity.js';

// ── Staleness Tests ──

describe('Memory Staleness', () => {
    describe('memoryAgeDays', () => {
        it('returns 0 for today', () => {
            expect(memoryAgeDays(new Date().toISOString())).toBe(0);
        });

        it('returns correct days for past dates', () => {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            expect(memoryAgeDays(threeDaysAgo)).toBe(3);
        });

        it('returns -1 for invalid date strings', () => {
            expect(memoryAgeDays('not-a-date')).toBe(-1);
            expect(memoryAgeDays('')).toBe(-1);
        });
    });

    describe('memoryFreshnessWarning', () => {
        it('returns empty for fresh entries (today)', () => {
            const entries = [{ id: '1', date: new Date().toISOString(), level: 'project' as const, category: 'test', tags: [], author: 'test', body: 'x' }];
            expect(memoryFreshnessWarning(entries)).toBe('');
        });

        it('returns empty for entries from yesterday', () => {
            const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
            const entries = [{ id: '1', date: yesterday, level: 'project' as const, category: 'test', tags: [], author: 'test', body: 'x' }];
            expect(memoryFreshnessWarning(entries)).toBe('');
        });

        it('returns warning for entries older than 1 day', () => {
            const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
            const entries = [{ id: '1', date: old, level: 'project' as const, category: 'test', tags: [], author: 'test', body: 'x' }];
            const warning = memoryFreshnessWarning(entries);
            expect(warning).toContain('Staleness');
            expect(warning).toContain('5 days ago');
        });

        it('returns empty for empty array', () => {
            expect(memoryFreshnessWarning([])).toBe('');
        });
    });
});

// ── Snapshot Tests ──

describe('Memory Snapshots', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-snap-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('checkMemorySnapshot', () => {
        it('returns none when no snapshot directory exists', () => {
            expect(checkMemorySnapshot(tmpDir)).toBe('none');
        });

        it('returns initialize when snapshot exists but not synced', () => {
            const snapDir = path.join(tmpDir, '.optimus', 'memory', 'snapshots');
            fs.mkdirSync(snapDir, { recursive: true });
            fs.writeFileSync(path.join(snapDir, 'conventions.md'), '# Conventions\n- Use TypeScript');

            expect(checkMemorySnapshot(tmpDir)).toBe('initialize');
        });

        it('returns synced after initialization', () => {
            const snapDir = path.join(tmpDir, '.optimus', 'memory', 'snapshots');
            fs.mkdirSync(snapDir, { recursive: true });
            fs.writeFileSync(path.join(snapDir, 'conventions.md'), '# Conventions');

            initializeFromSnapshot(tmpDir);
            expect(checkMemorySnapshot(tmpDir)).toBe('synced');
        });

        it('returns none when snapshot dir is empty', () => {
            const snapDir = path.join(tmpDir, '.optimus', 'memory', 'snapshots');
            fs.mkdirSync(snapDir, { recursive: true });

            expect(checkMemorySnapshot(tmpDir)).toBe('none');
        });
    });

    describe('initializeFromSnapshot', () => {
        it('copies snapshot files to memory directory', () => {
            const snapDir = path.join(tmpDir, '.optimus', 'memory', 'snapshots');
            const memDir = path.join(tmpDir, '.optimus', 'memory');
            fs.mkdirSync(snapDir, { recursive: true });
            fs.writeFileSync(path.join(snapDir, 'team-rules.md'), '# Rules');

            const result = initializeFromSnapshot(tmpDir);

            expect(result.copied).toBe(1);
            expect(fs.existsSync(path.join(memDir, 'team-rules.md'))).toBe(true);
        });

        it('does not overwrite existing memory files', () => {
            const snapDir = path.join(tmpDir, '.optimus', 'memory', 'snapshots');
            const memDir = path.join(tmpDir, '.optimus', 'memory');
            fs.mkdirSync(snapDir, { recursive: true });
            fs.mkdirSync(memDir, { recursive: true });

            fs.writeFileSync(path.join(snapDir, 'existing.md'), 'SNAPSHOT VERSION');
            fs.writeFileSync(path.join(memDir, 'existing.md'), 'LOCAL VERSION');

            const result = initializeFromSnapshot(tmpDir);

            expect(result.skipped).toBe(1);
            expect(fs.readFileSync(path.join(memDir, 'existing.md'), 'utf8')).toBe('LOCAL VERSION');
        });

        it('creates sync marker after initialization', () => {
            const snapDir = path.join(tmpDir, '.optimus', 'memory', 'snapshots');
            fs.mkdirSync(snapDir, { recursive: true });
            fs.writeFileSync(path.join(snapDir, 'test.md'), 'content');

            initializeFromSnapshot(tmpDir);

            const marker = path.join(tmpDir, '.optimus', 'memory', '.snapshot-synced.json');
            expect(fs.existsSync(marker)).toBe(true);
            const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
            expect(data.syncedAt).toBeGreaterThan(0);
        });
    });
});

// ── Path Security Tests ──

describe('Path Security', () => {
    describe('rejectNullBytes', () => {
        it('throws for paths with null bytes', () => {
            expect(() => rejectNullBytes('test\x00evil')).toThrow('null byte');
        });

        it('accepts normal paths', () => {
            expect(() => rejectNullBytes('/normal/path/file.md')).not.toThrow();
        });
    });

    describe('rejectUrlEncodedTraversal', () => {
        it('throws for URL-encoded ../', () => {
            expect(() => rejectUrlEncodedTraversal('%2e%2e%2fetc%2fpasswd')).toThrow('URL-encoded');
        });

        it('accepts normal paths', () => {
            expect(() => rejectUrlEncodedTraversal('/normal/path')).not.toThrow();
        });

        it('accepts paths with safe percent-encoding', () => {
            expect(() => rejectUrlEncodedTraversal('file%20name.md')).not.toThrow();
        });
    });

    describe('rejectUnicodeTraversal', () => {
        it('throws for fullwidth period', () => {
            expect(() => rejectUnicodeTraversal('test\uFF0E\uFF0Eevil')).toThrow('Unicode');
        });

        it('throws for fullwidth solidus', () => {
            expect(() => rejectUnicodeTraversal('test\uFF0Fevil')).toThrow('Unicode');
        });

        it('accepts normal paths', () => {
            expect(() => rejectUnicodeTraversal('/normal/path.md')).not.toThrow();
        });
    });

    describe('normalizeCaseForComparison', () => {
        it('lowercases on Windows/macOS', () => {
            const result = normalizeCaseForComparison('Path/To/FILE.md');
            if (process.platform === 'win32' || process.platform === 'darwin') {
                expect(result).toBe('path/to/file.md');
            } else {
                expect(result).toBe('Path/To/FILE.md');
            }
        });
    });

    describe('validatePathSecurity', () => {
        it('passes for safe paths', () => {
            expect(() => validatePathSecurity('/home/user/.optimus/memory/test.md')).not.toThrow();
        });

        it('rejects null bytes', () => {
            expect(() => validatePathSecurity('test\x00')).toThrow();
        });

        it('rejects unicode traversal', () => {
            expect(() => validatePathSecurity('\uFF0E\uFF0E\uFF0F')).toThrow();
        });
    });
});
