import { describe, it, expect, beforeEach } from 'vitest';
import { PromptCacheManager } from '../managers/PromptCacheManager.js';

describe('PromptCacheManager', () => {
    beforeEach(() => {
        PromptCacheManager.clearCache();
    });

    describe('splitPromptForCache', () => {
        it('splits at Task Description boundary', () => {
            const prompt = [
                'You are a delegated AI Worker.',
                '--- START PROJECT MEMORY ---',
                'Some memory content',
                '--- END PROJECT MEMORY ---',
                '',
                'Task Description:',
                'Do something specific for the architect role.',
                'Output to: .optimus/results/architect_review.md',
            ].join('\n');

            const parts = PromptCacheManager.splitPromptForCache(prompt);
            
            expect(parts.sharedPrefix).toContain('PROJECT MEMORY');
            expect(parts.sharedPrefix).not.toContain('Do something specific');
            expect(parts.uniqueSuffix).toContain('Task Description:');
            expect(parts.uniqueSuffix).toContain('Do something specific');
            expect(parts.fullPrompt).toBe(prompt);
            expect(parts.cacheKey).toBeTruthy();
            expect(parts.cacheKey.length).toBe(16);
        });

        it('produces identical cache keys for identical prefixes', () => {
            const shared = 'You are a worker.\n\nMemory content here.\n\nTask Description:\n';
            const prompt1 = shared + 'Task for role A';
            const prompt2 = shared + 'Task for role B';

            const parts1 = PromptCacheManager.splitPromptForCache(prompt1);
            const parts2 = PromptCacheManager.splitPromptForCache(prompt2);

            expect(parts1.cacheKey).toBe(parts2.cacheKey);
            expect(parts1.sharedPrefix).toBe(parts2.sharedPrefix);
            expect(parts1.uniqueSuffix).not.toBe(parts2.uniqueSuffix);
        });

        it('produces different cache keys for different prefixes', () => {
            const prompt1 = 'Context A\n\nTask Description:\nDo X';
            const prompt2 = 'Context B\n\nTask Description:\nDo X';

            const parts1 = PromptCacheManager.splitPromptForCache(prompt1);
            const parts2 = PromptCacheManager.splitPromptForCache(prompt2);

            expect(parts1.cacheKey).not.toBe(parts2.cacheKey);
        });

        it('falls back to 80% split when no marker found', () => {
            const prompt = 'A'.repeat(1000);
            const parts = PromptCacheManager.splitPromptForCache(prompt);

            expect(parts.sharedPrefix.length).toBeGreaterThan(0);
            expect(parts.uniqueSuffix.length).toBeGreaterThan(0);
            expect(parts.sharedPrefix + parts.uniqueSuffix).toBe(prompt);
        });

        it('reconstructs full prompt from parts', () => {
            const prompt = 'Header content\n\nTask Description:\nSome task\nOutput: file.md';
            const parts = PromptCacheManager.splitPromptForCache(prompt);

            expect(parts.sharedPrefix + parts.uniqueSuffix).toBe(parts.fullPrompt);
            expect(parts.fullPrompt).toBe(prompt);
        });
    });

    describe('hashPrefix', () => {
        it('returns consistent 16-char hex hash', () => {
            const hash1 = PromptCacheManager.hashPrefix('test content');
            const hash2 = PromptCacheManager.hashPrefix('test content');

            expect(hash1).toBe(hash2);
            expect(hash1.length).toBe(16);
            expect(/^[0-9a-f]+$/.test(hash1)).toBe(true);
        });

        it('returns different hashes for different content', () => {
            const hash1 = PromptCacheManager.hashPrefix('content A');
            const hash2 = PromptCacheManager.hashPrefix('content B');

            expect(hash1).not.toBe(hash2);
        });
    });

    describe('cache tracking', () => {
        it('tracks cache hits', () => {
            const prompt = 'Shared prefix\n\nTask Description:\nTask A';
            
            const parts1 = PromptCacheManager.splitPromptForCache(prompt);
            expect(PromptCacheManager.getHitCount(parts1.cacheKey)).toBe(1);

            // Same prefix again
            const prompt2 = 'Shared prefix\n\nTask Description:\nTask B';
            PromptCacheManager.splitPromptForCache(prompt2);
            expect(PromptCacheManager.getHitCount(parts1.cacheKey)).toBe(2);
        });

        it('reports cache stats', () => {
            PromptCacheManager.splitPromptForCache('X\n\nTask Description:\nA');
            PromptCacheManager.splitPromptForCache('X\n\nTask Description:\nB');

            const stats = PromptCacheManager.getCacheStats();
            expect(stats.entries).toBe(1);
            expect(stats.totalHits).toBe(2);
            expect(stats.totalBytes).toBeGreaterThan(0);
        });

        it('clears cache', () => {
            PromptCacheManager.splitPromptForCache('test\n\nTask Description:\nx');
            expect(PromptCacheManager.getCacheStats().entries).toBe(1);

            PromptCacheManager.clearCache();
            expect(PromptCacheManager.getCacheStats().entries).toBe(0);
        });

        it('isCached returns true for existing keys', () => {
            const parts = PromptCacheManager.splitPromptForCache('test\n\nTask Description:\nx');
            expect(PromptCacheManager.isCached(parts.cacheKey)).toBe(true);
            expect(PromptCacheManager.isCached('nonexistent')).toBe(false);
        });
    });
});
