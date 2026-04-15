import { parseFrontmatter } from '../harness/mechanicalLinter';

export interface RoleTemplateSpec {
    role: string;
    displayName: string;
    description: string;
    engine: string;
    model?: string;
    precipitatedAt: string;
    thin?: boolean;
}

const REQUIRED_SECTION_ORDER = [
    'Core Responsibilities',
    'Workflow',
    'Quality Standards',
    'Constraints',
    'Collaboration Contract',
    'Output Guidelines',
] as const;

function stripFence(content: string): string {
    const trimmed = content.trim();
    const fenceMatch = trimmed.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasSection(body: string, section: string): boolean {
    return new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'mi').test(body);
}

function buildPurposeParagraph(spec: RoleTemplateSpec): string {
    return `You are the **${spec.displayName}** for this workspace. ${spec.description} ` +
        `Operate with clear scope boundaries, concrete deliverables, and explicit verification.`;
}

function buildSectionContent(section: typeof REQUIRED_SECTION_ORDER[number], spec: RoleTemplateSpec): string {
    switch (section) {
        case 'Core Responsibilities':
            return [
                `- Own work in the ${spec.role} domain and keep decisions aligned with the stated task.`,
                '- Inspect existing project patterns, reusable abstractions, and constraints before proposing or changing anything.',
                '- Produce concrete deliverables that another agent or human can immediately review or execute.',
                '- Surface blockers, risks, and edge cases early instead of hiding uncertainty.',
            ].join('\n');
        case 'Workflow':
            return [
                '1. Clarify the goal, inputs, and success criteria before committing to an approach.',
                '2. Research the relevant files, symbols, and prior art before making recommendations or changes.',
                '3. Execute within your role boundary using the narrowest safe change set that solves the problem.',
                '4. Verify the result, summarize what changed, and call out any remaining risks or follow-ups.',
            ].join('\n');
        case 'Quality Standards':
            return [
                '- Prefer concrete file/function references over generic advice.',
                '- Reuse existing project patterns and conventions before inventing new ones.',
                '- Cover meaningful edge cases, validation, and failure modes instead of only the happy path.',
            ].join('\n');
        case 'Constraints':
            return [
                '- Stay within this role\'s responsibility; do not impersonate unrelated specialists.',
                '- Do not make sweeping assumptions when a short clarification or focused research step would resolve ambiguity.',
                '- Keep outputs actionable, reviewable, and scoped to the requested outcome.',
            ].join('\n');
        case 'Collaboration Contract':
            return [
                '- Hand off work in a form the orchestrator can verify quickly.',
                '- Cite the specific files, symbols, tests, or artifacts that informed your decisions.',
                '- Make dependencies, assumptions, and excluded scope explicit so downstream agents are not forced to rediscover them.',
            ].join('\n');
        case 'Output Guidelines':
            return [
                '- Structure responses so the main result is obvious first, followed by supporting detail.',
                '- Include verification evidence or recommended checks when the task changes behavior or code.',
                '- When multiple options exist, recommend one and explain the trade-off briefly.',
            ].join('\n');
    }
}

export function buildStructuredRoleTemplate(spec: RoleTemplateSpec): string {
    const frontmatter = [
        '---',
        `role: ${spec.role}`,
        'tier: T2',
        ...(spec.thin ? ['thin: true'] : []),
        `description: "${spec.description.substring(0, 200).replace(/"/g, "'")}"`,
        `engine: ${spec.engine}`,
        `model: ${spec.model || ''}`,
        `precipitated: ${spec.precipitatedAt}`,
        'auto_created: true',
        '---',
    ].join('\n');

    const sections = REQUIRED_SECTION_ORDER
        .map(section => `## ${section}\n${buildSectionContent(section, spec)}`)
        .join('\n\n');

    return [
        frontmatter,
        '',
        `# ${spec.displayName}`,
        '',
        buildPurposeParagraph(spec),
        '',
        sections,
        '',
    ].join('\n');
}

export function buildRoleCreatorPrompt(spec: RoleTemplateSpec, skillReference: string): string {
    return `You are a role-creation specialist. Your task is to create a high-quality Optimus T2 role template that reads like a mature specialist definition, not a thin placeholder.

Role name: ${spec.role}
Role display name: ${spec.displayName}
Role description: ${spec.description}
Engine: ${spec.engine}
Model: ${spec.model || 'default'}

Produce ONLY the final markdown file content. No explanation. No code fences.

Quality bar:
- Single clear responsibility with explicit boundaries
- Concrete workflow that tells the agent how to operate
- Explicit collaboration / handoff expectations
- Output guidance that forces concrete, reviewable deliverables
- Tight, scannable markdown with actionable bullets instead of vague prose

Required frontmatter (must exist exactly once at the top):
---
role: ${spec.role}
tier: T2
description: "<rich 1-2 sentence description>"
engine: ${spec.engine}
model: ${spec.model || ''}
precipitated: ${spec.precipitatedAt}
auto_created: true
---

Required body requirements:
- Start with: # ${spec.displayName}
- Include a short purpose statement immediately after the title
- Include ALL of these sections exactly once:
  - ## Core Responsibilities
  - ## Workflow
  - ## Quality Standards
  - ## Constraints
  - ## Collaboration Contract
  - ## Output Guidelines

Section guidance:
- Core Responsibilities: 3-5 concrete responsibilities with deliverables
- Workflow: 4 numbered steps covering clarify → inspect → execute → verify/handoff
- Quality Standards: 3 measurable quality criteria
- Constraints: 2-4 explicit boundaries, including at least one \"do not\" behavior
- Collaboration Contract: how this role works with orchestrators and adjacent specialists
- Output Guidelines: how this role should present results so they are actionable

Do NOT:
- Output a generic one-paragraph agent
- Use placeholders like "<fill me in>" or "TBD"
- Mention VS Code, Copilot-specific tool syntax, or UI-only concepts
- Start implementation-specific instructions unless they are part of the role's general operating contract

Modeling note:
- Borrow the quality of a strong planning/specification agent definition: explicit scope, structured workflow, clarification discipline, and clear handoffs.
- Keep the content compatible with Optimus T2 role templates.

${skillReference ? `=== ROLE-CREATOR SKILL REFERENCE ===\n${skillReference}\n=== END ROLE-CREATOR SKILL REFERENCE ===` : ''}`;
}

export function normalizeGeneratedRoleTemplate(rawContent: string, spec: RoleTemplateSpec): string {
    const cleaned = stripFence(rawContent);
    const parsed = parseFrontmatter(cleaned);
    const existingBody = parsed?.body?.trim() || cleaned;
    const existingMeta = parsed?.meta || {};
    const baseTemplate = buildStructuredRoleTemplate(spec);
    const baseParsed = parseFrontmatter(baseTemplate);
    const baseBody = baseParsed?.body || '';
    const bodySections = existingBody || baseBody;

    const mergedMeta: Record<string, string> = {
        role: spec.role,
        tier: 'T2',
        description: existingMeta.description || spec.description.substring(0, 200).replace(/"/g, "'"),
        engine: spec.engine,
        model: spec.model || '',
        precipitated: spec.precipitatedAt,
        auto_created: 'true',
    };

    let normalizedBody = bodySections.trim();
    if (!/^#\s+/m.test(normalizedBody)) {
        normalizedBody = `# ${spec.displayName}\n\n${normalizedBody}`.trim();
    } else {
        normalizedBody = normalizedBody.replace(/^#\s+.*$/m, `# ${spec.displayName}`);
    }

    if (!new RegExp(`^#\\s+${escapeRegExp(spec.displayName)}\\s*$`, 'm').test(normalizedBody)) {
        normalizedBody = `# ${spec.displayName}\n\n${normalizedBody.replace(/^#\s+.*$/m, '').trim()}`;
    }

    const titleAndRest = normalizedBody.split(/\n+/);
    const titleLine = titleAndRest.shift() || `# ${spec.displayName}`;
    let rest = titleAndRest.join('\n').trim();
    if (!rest || /^##\s+/m.test(rest.split('\n')[0] || '')) {
        rest = `${buildPurposeParagraph(spec)}\n\n${rest}`.trim();
    }
    normalizedBody = `${titleLine}\n\n${rest}`.trim();

    for (const section of REQUIRED_SECTION_ORDER) {
        if (!hasSection(normalizedBody, section)) {
            normalizedBody += `\n\n## ${section}\n${buildSectionContent(section, spec)}`;
        }
    }

    const frontmatter = [
        '---',
        `role: ${mergedMeta.role}`,
        `tier: ${mergedMeta.tier}`,
        `description: "${mergedMeta.description.replace(/"/g, "'")}"`,
        `engine: ${mergedMeta.engine}`,
        `model: ${mergedMeta.model}`,
        `precipitated: ${mergedMeta.precipitated}`,
        `auto_created: ${mergedMeta.auto_created}`,
        '---',
    ].join('\n');

    return `${frontmatter}\n\n${normalizedBody.trim()}\n`;
}
