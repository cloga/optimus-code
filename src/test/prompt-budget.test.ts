import { describe, expect, it } from 'vitest';
import { truncatePromptSection } from '../utils/promptBudget.js';

describe('truncatePromptSection', () => {
    it('returns untouched content when under budget', () => {
        const content = 'line 1\nline 2';
        expect(truncatePromptSection(content, 200, 'test section')).toBe(content);
    });

    it('truncates long content and appends actionable notice', () => {
        const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
        const result = truncatePromptSection(content, 120, 'context file', 'Read the file from disk if needed.');

        expect(result.length).toBeLessThanOrEqual(220);
        expect(result).toContain('[... context file truncated by Optimus:');
        expect(result).toContain('Read the file from disk if needed.');
        expect(result).toContain('line 0');
    });

    it('falls back to notice-only output when budget is tiny', () => {
        const result = truncatePromptSection('abcdefghijklmnopqrstuvwxyz', 10, 'skill');
        expect(result).toContain('skill truncated by Optimus');
    });
});
