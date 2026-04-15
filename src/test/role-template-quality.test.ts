import { describe, expect, it } from 'vitest';
import { buildRoleCreatorPrompt, buildStructuredRoleTemplate, normalizeGeneratedRoleTemplate } from '../mcp/role-template-quality';

describe('role template quality helpers', () => {
    const spec = {
        role: 'plan-specialist',
        displayName: 'Plan Specialist',
        description: 'Planning specialist who researches scope, aligns stakeholders, and produces actionable implementation plans.',
        engine: 'claude-code',
        model: 'claude-opus-4.6-1m',
        precipitatedAt: '2026-04-15T00:00:00.000Z',
    };

    it('builds a role-creator prompt with explicit quality requirements', () => {
        const prompt = buildRoleCreatorPrompt(spec, 'skill reference');
        expect(prompt).toContain('Single clear responsibility with explicit boundaries');
        expect(prompt).toContain('## Collaboration Contract');
        expect(prompt).toContain('## Output Guidelines');
        expect(prompt).toContain('skill reference');
    });

    it('builds a structured fallback template with rich sections', () => {
        const template = buildStructuredRoleTemplate(spec);
        expect(template).toContain('role: plan-specialist');
        expect(template).toContain('## Workflow');
        expect(template).toContain('## Collaboration Contract');
        expect(template).toContain('## Output Guidelines');
    });

    it('normalizes sparse LLM output into a richer compatible role template', () => {
        const normalized = normalizeGeneratedRoleTemplate(`---
role: plan-specialist
tier: T2
description: "Planner"
engine: claude-code
model: claude-opus-4.6-1m
---

# Plan Specialist

Short body`, spec);

        expect(normalized).toContain('auto_created: true');
        expect(normalized).toContain('## Core Responsibilities');
        expect(normalized).toContain('## Workflow');
        expect(normalized).toContain('## Quality Standards');
        expect(normalized).toContain('## Constraints');
        expect(normalized).toContain('## Collaboration Contract');
        expect(normalized).toContain('## Output Guidelines');
    });
});
