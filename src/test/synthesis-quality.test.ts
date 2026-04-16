import { describe, it, expect } from 'vitest';
import { scoreSynthesisQuality, isLowQualitySynthesis } from '../mcp/synthesis-coordinator';

const HIGH_QUALITY_FINDINGS = `## Synthesized Findings from code-architect

### Document Structure
- Requirements
- Design
- Tests

### Key Conclusions
The design preserves backward compatibility and adds telemetry.

### Notable Points
- important: audit log must be append-only
- critical: quality gate is observational, not blocking

*Synthesized at 2026-04-16T23:00:00.000Z*
`;

const FALLBACK_ONLY_FINDINGS = `## Synthesized Findings from dev

### Output Summary (first 30 non-empty lines)
line 1
line 2
line 3

*Synthesized at 2026-04-16T23:00:00.000Z*
`;

describe('scoreSynthesisQuality', () => {
    it('rewards structured syntheses with a high score', () => {
        const q = scoreSynthesisQuality('x'.repeat(500), HIGH_QUALITY_FINDINGS, false);
        expect(q.score).toBeGreaterThanOrEqual(0.9);
        expect(q.fallback_only).toBe(false);
        expect(q.truncated).toBe(false);
        expect(q.flags).toEqual([]);
        expect(isLowQualitySynthesis(q)).toBe(false);
    });

    it('flags fallback-only syntheses as low quality', () => {
        const q = scoreSynthesisQuality('raw output', FALLBACK_ONLY_FINDINGS, false);
        expect(q.fallback_only).toBe(true);
        expect(q.score).toBeLessThan(0.3);
        expect(isLowQualitySynthesis(q)).toBe(true);
        expect(q.flags.join(' ')).toContain('fallback_only');
    });

    it('records truncation flag when source exceeded extractor cap', () => {
        const q = scoreSynthesisQuality('x'.repeat(50_000), HIGH_QUALITY_FINDINGS, true);
        expect(q.truncated).toBe(true);
        expect(q.flags.some(f => f.startsWith('source_truncated'))).toBe(true);
    });

    it('returns zero for empty source', () => {
        const q = scoreSynthesisQuality('', FALLBACK_ONLY_FINDINGS, false);
        expect(q.score).toBe(0);
        expect(q.flags.some(f => f === 'empty_source: predecessor produced no output')).toBe(true);
        expect(isLowQualitySynthesis(q)).toBe(true);
    });

    it('flags synthesis that is too short', () => {
        const tiny = `## Synthesized Findings from dev\n\n### Key Conclusions\n\nshort\n\n*Synthesized at x*`;
        const q = scoreSynthesisQuality('raw', tiny, false);
        expect(q.flags.some(f => f.startsWith('synthesis_too_short'))).toBe(true);
    });

    it('clamps score to [0, 1]', () => {
        const q = scoreSynthesisQuality('', 'junk', true);
        expect(q.score).toBeGreaterThanOrEqual(0);
        expect(q.score).toBeLessThanOrEqual(1);
    });
});
