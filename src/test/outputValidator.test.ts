import { describe, it, expect } from 'vitest';
import { validateOutput, ValidationContext } from '../harness/outputValidator';

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
    return {
        role: 'test-role',
        outputPath: '/tmp/out.json',
        engine: 'github-copilot',
        verificationLevel: 'normal',
        ...overrides,
    };
}

describe('outputValidator', () => {
    describe('EmptyOutput rule', () => {
        it('fails on empty string', () => {
            const r = validateOutput('', ctx());
            expect(r.severity).toBe('fail');
            expect(r.issues[0].rule).toBe('empty-output');
        });

        it('warns on very short output', () => {
            const r = validateOutput('ok', ctx());
            expect(r.severity).toBe('warn');
            expect(r.issues[0].rule).toBe('empty-output');
        });

        it('passes on normal output', () => {
            const r = validateOutput('This is a detailed analysis of the problem with multiple considerations.', ctx());
            expect(r.severity).toBe('pass');
        });
    });

    describe('SchemaCompliance rule', () => {
        const schema = {
            type: 'object',
            properties: { name: { type: 'string' }, age: { type: 'number' } },
            required: ['name', 'age'],
        };

        it('passes when JSON matches schema', () => {
            const r = validateOutput('{"name":"Alice","age":30}', ctx({ outputSchema: schema }));
            expect(r.issues.filter(i => i.rule === 'schema-compliance')).toHaveLength(0);
        });

        it('fails when JSON is missing required fields', () => {
            const r = validateOutput('{"name":"Alice"}', ctx({ outputSchema: schema }));
            expect(r.severity).toBe('fail');
            expect(r.issues.find(i => i.rule === 'schema-compliance')?.message).toContain('age');
        });

        it('fails on non-JSON output when schema is specified', () => {
            const r = validateOutput('This is just text, not JSON at all.', ctx({ outputSchema: schema }));
            expect(r.severity).toBe('fail');
        });

        it('extracts JSON from code fence', () => {
            const output = 'Here is the result:\n```json\n{"name":"Bob","age":25}\n```\nDone.';
            const r = validateOutput(output, ctx({ outputSchema: schema }));
            expect(r.issues.filter(i => i.rule === 'schema-compliance')).toHaveLength(0);
        });
    });

    describe('PrematureCompletion rule', () => {
        it('warns on short "done" declarations', () => {
            const r = validateOutput("I've completed the task successfully.", ctx());
            expect(r.issues.find(i => i.rule === 'premature-completion')).toBeDefined();
        });

        it('does not warn on long substantive output', () => {
            const longOutput = "I've completed the task. " + 'x'.repeat(300);
            const r = validateOutput(longOutput, ctx());
            expect(r.issues.find(i => i.rule === 'premature-completion')).toBeUndefined();
        });
    });

    describe('UnfinishedCode rule', () => {
        it('warns when multiple TODO markers found', () => {
            const r = validateOutput('function foo() { TODO: implement } // FIXME: broken', ctx());
            expect(r.issues.find(i => i.rule === 'unfinished-code')).toBeDefined();
        });

        it('does not warn on single marker', () => {
            const r = validateOutput('function foo() { return 42; } // TODO: add tests later', ctx());
            expect(r.issues.find(i => i.rule === 'unfinished-code')).toBeUndefined();
        });
    });

    describe('ErrorLeak rule', () => {
        it('warns on stack traces', () => {
            const r = validateOutput('Result:\nTraceback (most recent call last):\n  File "x.py"', ctx());
            expect(r.issues.find(i => i.rule === 'error-leak')).toBeDefined();
        });
    });

    describe('verificationLevel', () => {
        it('skip bypasses all checks', () => {
            const r = validateOutput('', ctx({ verificationLevel: 'skip' }));
            expect(r.valid).toBe(true);
            expect(r.issues).toHaveLength(0);
        });

        it('strict fails on warnings', () => {
            const r = validateOutput("I've completed the task.", ctx({ verificationLevel: 'strict' }));
            expect(r.severity).toBe('fail');
        });

        it('normal allows warnings through', () => {
            const r = validateOutput("I've completed the task.", ctx({ verificationLevel: 'normal' }));
            expect(r.severity).toBe('warn');
            expect(r.valid).toBe(true);
        });
    });
});
