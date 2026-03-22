import { describe, it, expect } from 'vitest';
import {
    parseFrontmatter,
    lintRoleTemplate,
    lintSkillFile,
    lintArtifactOutput,
    lintEngineModel,
    EngineRegistry,
} from '../harness/mechanicalLinter';

describe('mechanicalLinter', () => {
    describe('parseFrontmatter', () => {
        it('parses valid frontmatter', () => {
            const result = parseFrontmatter('---\nrole: test\ntier: T2\n---\n# Body');
            expect(result).not.toBeNull();
            expect(result!.meta.role).toBe('test');
            expect(result!.meta.tier).toBe('T2');
            expect(result!.body).toBe('# Body');
        });

        it('strips quotes from values', () => {
            const result = parseFrontmatter('---\ndesc: "hello world"\n---\nbody');
            expect(result!.meta.desc).toBe('hello world');
        });

        it('returns null for no frontmatter', () => {
            expect(parseFrontmatter('# Just a heading')).toBeNull();
        });
    });

    describe('lintRoleTemplate', () => {
        const validRole = `---
role: code-reviewer
tier: T2
description: "Reviews code for quality issues"
engine: claude-code
model: claude-opus-4.6-1m
---
# Code Reviewer

You are an expert code reviewer.

## Core Responsibilities
- Review code for bugs
- Check for security issues
- Verify test coverage
- Ensure documentation exists
- Follow coding standards
- Check error handling
- Review naming conventions
- Verify API contracts
- Check for race conditions
- Review performance
- Ensure accessibility
- Check compatibility
- Review logging
- Verify config handling
- Check for memory leaks
- Review error messages
- Ensure idempotency
- Check input validation
- Review retry logic
- Verify graceful degradation
- Check timeout handling
- Review caching strategy
- Ensure proper cleanup
- Check resource limits
- Verify monitoring hooks`;

        it('passes valid role template', () => {
            const result = lintRoleTemplate(validRole, 'test.md');
            expect(result.passed).toBe(true);
        });

        it('fails on missing frontmatter', () => {
            const result = lintRoleTemplate('# No frontmatter here', 'test.md');
            expect(result.passed).toBe(false);
            expect(result.issues[0].rule).toBe('role-frontmatter-missing');
        });

        it('fails on missing required fields', () => {
            const result = lintRoleTemplate('---\ntier: T2\n---\n# Body\n' + 'x\n'.repeat(30), 'test.md');
            expect(result.passed).toBe(false);
            const missingRules = result.issues.filter(i => i.rule === 'role-field-missing');
            expect(missingRules.length).toBeGreaterThanOrEqual(2); // role, description, engine
        });

        it('fails on invalid role name', () => {
            const result = lintRoleTemplate('---\nrole: Code_Reviewer\ndescription: test\nengine: x\n---\n' + 'x\n'.repeat(30), 'test.md');
            expect(result.issues.find(i => i.rule === 'role-name-format')).toBeDefined();
        });

        it('fails on wrong tier', () => {
            const result = lintRoleTemplate('---\nrole: test\ntier: T1\ndescription: test\nengine: x\n---\n' + 'x\n'.repeat(30), 'test.md');
            expect(result.issues.find(i => i.rule === 'role-tier-invalid')).toBeDefined();
        });

        it('warns on thin template', () => {
            const result = lintRoleTemplate('---\nrole: test\ndescription: test\nengine: x\n---\n# Short\nJust a few lines.', 'test.md');
            expect(result.issues.find(i => i.rule === 'role-thin-template')).toBeDefined();
        });

        it('fails on invalid status', () => {
            const result = lintRoleTemplate('---\nrole: test\ndescription: test\nengine: x\nstatus: broken\n---\n' + 'x\n'.repeat(30), 'test.md');
            expect(result.issues.find(i => i.rule === 'role-status-invalid')).toBeDefined();
        });
    });

    describe('lintSkillFile', () => {
        it('passes valid skill', () => {
            const content = '---\nname: git-workflow\ndescription: Standard VCS workflow\n---\n# Git Workflow\n\nStep 1\nStep 2\nStep 3\nStep 4\nStep 5';
            const result = lintSkillFile(content, 'SKILL.md');
            expect(result.passed).toBe(true);
        });

        it('fails on missing name', () => {
            const content = '---\ndescription: test\n---\n# Body\n' + 'x\n'.repeat(10);
            const result = lintSkillFile(content, 'SKILL.md');
            expect(result.issues.find(i => i.rule === 'skill-field-missing')).toBeDefined();
        });

        it('warns on thin body', () => {
            const content = '---\nname: test\ndescription: test\n---\nShort.';
            const result = lintSkillFile(content, 'SKILL.md');
            expect(result.issues.find(i => i.rule === 'skill-thin-body')).toBeDefined();
        });
    });

    describe('lintArtifactOutput', () => {
        it('warns on missing frontmatter (advisory)', () => {
            const result = lintArtifactOutput('# Just content', 'out.md');
            expect(result.passed).toBe(true); // advisory only
            expect(result.issues[0].rule).toBe('artifact-frontmatter-missing');
        });

        it('passes valid artifact', () => {
            const content = '---\ntype: task\nstatus: completed\nauthor: builder\ndate: 2026-03-22\n---\n# Result';
            const result = lintArtifactOutput(content, 'out.md');
            expect(result.issues).toHaveLength(0);
        });

        it('warns on invalid type', () => {
            const content = '---\ntype: unknown\nstatus: completed\nauthor: x\ndate: 2026-01-01\n---\nbody';
            const result = lintArtifactOutput(content, 'out.md');
            expect(result.issues.find(i => i.rule === 'artifact-type-invalid')).toBeDefined();
        });

        it('warns on bad date format', () => {
            const content = '---\ntype: task\nstatus: completed\nauthor: x\ndate: March 22\n---\nbody';
            const result = lintArtifactOutput(content, 'out.md');
            expect(result.issues.find(i => i.rule === 'artifact-date-format')).toBeDefined();
        });
    });

    describe('lintEngineModel', () => {
        const registry: EngineRegistry = {
            'claude-code': ['claude-opus-4.6-1m', 'gpt-5.4'],
            'github-copilot': ['gpt-5.4', 'gemini-3-pro-preview'],
        };

        it('passes valid engine+model', () => {
            const issues = lintEngineModel('claude-code', 'claude-opus-4.6-1m', registry, 'test');
            expect(issues).toHaveLength(0);
        });

        it('fails on unknown engine', () => {
            const issues = lintEngineModel('openai-codex', 'gpt-5', registry, 'test');
            expect(issues[0].rule).toBe('engine-unknown');
        });

        it('fails on invalid model for engine', () => {
            const issues = lintEngineModel('claude-code', 'nonexistent-model', registry, 'test');
            expect(issues[0].rule).toBe('model-unknown');
        });

        it('passes model-less engine', () => {
            const issues = lintEngineModel('claude-code', undefined, registry, 'test');
            expect(issues).toHaveLength(0);
        });
    });
});
