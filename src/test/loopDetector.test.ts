import { describe, it, expect, beforeEach } from 'vitest';
import {
    trackFileEdit,
    getEditCount,
    checkForLoop,
    extractEditedFiles,
    analyzeOutputForLoops,
    clearSession,
} from '../harness/loopDetector';

describe('loopDetector', () => {
    beforeEach(() => {
        clearSession('test-session');
    });

    describe('trackFileEdit / getEditCount', () => {
        it('starts at 0', () => {
            expect(getEditCount('test-session', 'src/foo.ts')).toBe(0);
        });

        it('increments on each track call', () => {
            trackFileEdit('test-session', 'src/foo.ts');
            trackFileEdit('test-session', 'src/foo.ts');
            expect(getEditCount('test-session', 'src/foo.ts')).toBe(2);
        });

        it('normalizes paths (case + separators)', () => {
            trackFileEdit('test-session', 'src\\Foo.ts');
            trackFileEdit('test-session', 'src/foo.ts');
            expect(getEditCount('test-session', 'SRC/FOO.TS')).toBe(2);
        });
    });

    describe('checkForLoop', () => {
        it('returns null below threshold', () => {
            trackFileEdit('test-session', 'a.ts');
            trackFileEdit('test-session', 'a.ts');
            expect(checkForLoop('test-session', 3)).toBeNull();
        });

        it('detects loop at threshold', () => {
            for (let i = 0; i < 3; i++) trackFileEdit('test-session', 'a.ts');
            const warning = checkForLoop('test-session', 3);
            expect(warning).not.toBeNull();
            expect(warning!.files[0].count).toBe(3);
            expect(warning!.suggestion).toContain('doom loop');
        });

        it('reports multiple hot files sorted by count', () => {
            for (let i = 0; i < 5; i++) trackFileEdit('test-session', 'b.ts');
            for (let i = 0; i < 3; i++) trackFileEdit('test-session', 'a.ts');
            const warning = checkForLoop('test-session', 3);
            expect(warning!.files).toHaveLength(2);
            expect(warning!.files[0].path).toContain('b.ts');
        });
    });

    describe('extractEditedFiles', () => {
        it('extracts paths from edit_file tool calls', () => {
            const output = `Some text\nedit_file({ path: "src/main.ts", content: "..." })`;
            const files = extractEditedFiles(output);
            expect(files).toContain('src/main.ts');
        });

        it('extracts paths from write_file tool calls', () => {
            const output = `write_file({ file_path: 'lib/util.js' })`;
            const files = extractEditedFiles(output);
            expect(files).toContain('lib/util.js');
        });

        it('extracts from writeFileSync calls', () => {
            const output = `fs.writeFileSync("out/data.json", content)`;
            const files = extractEditedFiles(output);
            expect(files).toContain('out/data.json');
        });

        it('returns empty for output with no file edits', () => {
            const files = extractEditedFiles('Just normal text output.');
            expect(files).toHaveLength(0);
        });
    });

    describe('analyzeOutputForLoops', () => {
        it('tracks and detects across multiple calls', () => {
            const output = `edit_file({ path: "x.ts" })`;
            expect(analyzeOutputForLoops('test-session', output, 3)).toBeNull();
            expect(analyzeOutputForLoops('test-session', output, 3)).toBeNull();
            const warning = analyzeOutputForLoops('test-session', output, 3);
            expect(warning).not.toBeNull();
        });
    });
});
