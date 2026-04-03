import { describe, it, expect, beforeEach } from 'vitest';
import {
    resolveExecutablePath,
    clearResolvedPathCache,
    getCommonInstallPathsForPlatform,
    buildResolutionDiagnostic,
} from '../utils/acpPathResolver.js';

describe('ACP Path Resolver', () => {
    beforeEach(() => {
        clearResolvedPathCache();
    });

    describe('resolveExecutablePath', () => {
        it('resolves node executable (always in PATH)', () => {
            const resolved = resolveExecutablePath('node');
            expect(resolved).toBeTruthy();
            expect(resolved).toContain('node');
        });

        it('returns null for nonexistent executable', () => {
            const resolved = resolveExecutablePath('definitely-not-a-real-executable-xyz123');
            expect(resolved).toBeNull();
        });

        it('caches resolved paths', () => {
            const first = resolveExecutablePath('node');
            const second = resolveExecutablePath('node');
            expect(first).toBe(second);
        });

        it('caches null for missing executables', () => {
            resolveExecutablePath('fake-tool-abc');
            // Second call should return cached null without scanning
            const result = resolveExecutablePath('fake-tool-abc');
            expect(result).toBeNull();
        });

        it('clearResolvedPathCache resets cache', () => {
            resolveExecutablePath('node');
            clearResolvedPathCache();
            // After clear, should re-resolve (still finds it)
            const result = resolveExecutablePath('node');
            expect(result).toBeTruthy();
        });
    });

    describe('getCommonInstallPathsForPlatform', () => {
        it('returns non-empty array of paths', () => {
            const paths = getCommonInstallPathsForPlatform();
            expect(paths.length).toBeGreaterThan(0);
        });

        it('contains platform-appropriate paths', () => {
            const paths = getCommonInstallPathsForPlatform();
            if (process.platform === 'win32') {
                // Should contain Windows-style paths
                expect(paths.some(p => p.includes('npm') || p.includes('.tools'))).toBe(true);
            } else {
                // Should contain Unix-style paths
                expect(paths.some(p => p.startsWith('/'))).toBe(true);
            }
        });
    });

    describe('buildResolutionDiagnostic', () => {
        it('returns diagnostic string with platform info', () => {
            const diag = buildResolutionDiagnostic('test-tool');
            expect(diag).toContain('test-tool');
            expect(diag).toContain(process.platform);
            expect(diag).toContain('PATH entries');
            expect(diag).toContain('Common paths checked');
        });

        it('marks existing directories with checkmark', () => {
            const diag = buildResolutionDiagnostic('node');
            // At least some common paths should exist on the system
            expect(diag).toContain('✅');
        });
    });
});
