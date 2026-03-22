/**
 * Mechanical Linting — Harness Engineering
 *
 * Deterministic (non-LLM) validation rules for Optimus artifacts:
 * role templates, skill files, task outputs, and config files.
 *
 * Inspired by OpenAI's structural tests and dependency layering enforcement.
 */

// ── Types ───────────────────────────────────────────────────────

export interface LintIssue {
    rule: string;
    file: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
    line?: number;
}

export interface LintResult {
    file: string;
    issues: LintIssue[];
    passed: boolean;
}

// ── Frontmatter Parser ──────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } | null {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return null;

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) meta[key] = value;
    }

    return { meta, body: match[2] };
}

// ── Role Template Linter ────────────────────────────────────────

const VALID_ROLE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ROLE_REQUIRED_FIELDS = ['role', 'description', 'engine'];

export function lintRoleTemplate(content: string, filePath: string): LintResult {
    const issues: LintIssue[] = [];

    const parsed = parseFrontmatter(content);
    if (!parsed) {
        issues.push({
            rule: 'role-frontmatter-missing',
            file: filePath,
            message: 'Role template must start with YAML frontmatter (--- block).',
            severity: 'error',
        });
        return { file: filePath, issues, passed: false };
    }

    const { meta, body } = parsed;

    // Required fields
    for (const field of ROLE_REQUIRED_FIELDS) {
        if (!meta[field]) {
            issues.push({
                rule: 'role-field-missing',
                file: filePath,
                message: `Required frontmatter field '${field}' is missing.`,
                severity: 'error',
            });
        }
    }

    // Role name format
    if (meta.role && !VALID_ROLE_NAME.test(meta.role)) {
        issues.push({
            rule: 'role-name-format',
            file: filePath,
            message: `Role name '${meta.role}' must be kebab-case (a-z, 0-9, hyphens).`,
            severity: 'error',
        });
    }

    // Tier must be T2
    if (meta.tier && meta.tier !== 'T2') {
        issues.push({
            rule: 'role-tier-invalid',
            file: filePath,
            message: `Role template tier must be 'T2', got '${meta.tier}'.`,
            severity: 'error',
        });
    }

    // Thin template check
    const contentLines = body.split('\n').filter(l => l.trim().length > 0);
    if (contentLines.length < 25) {
        issues.push({
            rule: 'role-thin-template',
            file: filePath,
            message: `Role body has only ${contentLines.length} non-empty lines (min 25 for rich template).`,
            severity: 'warning',
        });
    }

    // Status field validation
    const VALID_STATUSES = ['active', 'quarantined', 'deprecated'];
    if (meta.status && !VALID_STATUSES.includes(meta.status)) {
        issues.push({
            rule: 'role-status-invalid',
            file: filePath,
            message: `Invalid status '${meta.status}'. Valid: ${VALID_STATUSES.join(', ')}.`,
            severity: 'error',
        });
    }

    return { file: filePath, issues, passed: issues.filter(i => i.severity === 'error').length === 0 };
}

// ── Skill File Linter ───────────────────────────────────────────

const SKILL_REQUIRED_FIELDS = ['name', 'description'];

export function lintSkillFile(content: string, filePath: string): LintResult {
    const issues: LintIssue[] = [];

    const parsed = parseFrontmatter(content);
    if (!parsed) {
        issues.push({
            rule: 'skill-frontmatter-missing',
            file: filePath,
            message: 'Skill file must start with YAML frontmatter (--- block).',
            severity: 'error',
        });
        return { file: filePath, issues, passed: false };
    }

    const { meta, body } = parsed;

    for (const field of SKILL_REQUIRED_FIELDS) {
        if (!meta[field]) {
            issues.push({
                rule: 'skill-field-missing',
                file: filePath,
                message: `Required frontmatter field '${field}' is missing.`,
                severity: 'error',
            });
        }
    }

    // Skill name should be kebab-case
    if (meta.name && !VALID_ROLE_NAME.test(meta.name)) {
        issues.push({
            rule: 'skill-name-format',
            file: filePath,
            message: `Skill name '${meta.name}' must be kebab-case.`,
            severity: 'warning',
        });
    }

    // Body should have some content
    const bodyLines = body.split('\n').filter(l => l.trim().length > 0);
    if (bodyLines.length < 5) {
        issues.push({
            rule: 'skill-thin-body',
            file: filePath,
            message: `Skill body has only ${bodyLines.length} non-empty lines (expected at least 5).`,
            severity: 'warning',
        });
    }

    return { file: filePath, issues, passed: issues.filter(i => i.severity === 'error').length === 0 };
}

// ── Artifact Output Linter ──────────────────────────────────────

const VALID_ARTIFACT_TYPES = ['problem', 'proposal', 'solution', 'review', 'verdict', 'report', 'task', 'memory'];
const VALID_ARTIFACT_STATUSES = ['open', 'draft', 'in-review', 'approved', 'rejected', 'completed', 'failed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export function lintArtifactOutput(content: string, filePath: string): LintResult {
    const issues: LintIssue[] = [];

    const parsed = parseFrontmatter(content);
    if (!parsed) {
        // Artifact frontmatter is advisory — warn but don't fail
        issues.push({
            rule: 'artifact-frontmatter-missing',
            file: filePath,
            message: 'Artifact should have YAML frontmatter with type, status, author, date.',
            severity: 'warning',
        });
        return { file: filePath, issues, passed: true };
    }

    const { meta } = parsed;

    // Check type
    if (!meta.type) {
        issues.push({
            rule: 'artifact-type-missing',
            file: filePath,
            message: 'Artifact frontmatter should include a "type" field.',
            severity: 'warning',
        });
    } else if (!VALID_ARTIFACT_TYPES.includes(meta.type)) {
        issues.push({
            rule: 'artifact-type-invalid',
            file: filePath,
            message: `Invalid artifact type '${meta.type}'. Valid: ${VALID_ARTIFACT_TYPES.join(', ')}.`,
            severity: 'warning',
        });
    }

    // Check status
    if (!meta.status) {
        issues.push({
            rule: 'artifact-status-missing',
            file: filePath,
            message: 'Artifact frontmatter should include a "status" field.',
            severity: 'warning',
        });
    } else if (!VALID_ARTIFACT_STATUSES.includes(meta.status)) {
        issues.push({
            rule: 'artifact-status-invalid',
            file: filePath,
            message: `Invalid artifact status '${meta.status}'. Valid: ${VALID_ARTIFACT_STATUSES.join(', ')}.`,
            severity: 'warning',
        });
    }

    // Check author
    if (!meta.author) {
        issues.push({
            rule: 'artifact-author-missing',
            file: filePath,
            message: 'Artifact frontmatter should include an "author" field.',
            severity: 'warning',
        });
    }

    // Check date format
    if (meta.date && !DATE_RE.test(meta.date)) {
        issues.push({
            rule: 'artifact-date-format',
            file: filePath,
            message: `Date '${meta.date}' should be ISO-8601 (YYYY-MM-DD).`,
            severity: 'warning',
        });
    }

    return { file: filePath, issues, passed: issues.filter(i => i.severity === 'error').length === 0 };
}

// ── Engine/Model Config Linter ──────────────────────────────────

export interface EngineRegistry {
    [engine: string]: string[];  // engine → valid model list
}

/**
 * Validate that a role's engine+model combination is valid against the registry.
 */
export function lintEngineModel(
    engine: string,
    model: string | undefined,
    registry: EngineRegistry,
    context: string
): LintIssue[] {
    const issues: LintIssue[] = [];

    if (!registry[engine]) {
        issues.push({
            rule: 'engine-unknown',
            file: context,
            message: `Engine '${engine}' not found in available-agents.json. Valid: ${Object.keys(registry).join(', ')}.`,
            severity: 'error',
        });
        return issues;
    }

    if (model && registry[engine].length > 0 && !registry[engine].includes(model)) {
        issues.push({
            rule: 'model-unknown',
            file: context,
            message: `Model '${model}' not valid for engine '${engine}'. Valid: ${registry[engine].join(', ')}.`,
            severity: 'error',
        });
    }

    return issues;
}

// ── Batch Linter ────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';

/**
 * Lint all role templates in a workspace.
 */
export function lintAllRoles(workspacePath: string): LintResult[] {
    const rolesDir = path.join(workspacePath, '.optimus', 'roles');
    if (!fs.existsSync(rolesDir)) return [];

    const results: LintResult[] = [];
    for (const file of fs.readdirSync(rolesDir)) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(rolesDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        results.push(lintRoleTemplate(content, filePath));
    }
    return results;
}

/**
 * Lint all skills in a workspace.
 */
export function lintAllSkills(workspacePath: string): LintResult[] {
    const skillsDir = path.join(workspacePath, '.optimus', 'skills');
    if (!fs.existsSync(skillsDir)) return [];

    const results: LintResult[] = [];
    for (const dir of fs.readdirSync(skillsDir)) {
        const skillFile = path.join(skillsDir, dir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const content = fs.readFileSync(skillFile, 'utf8');
        results.push(lintSkillFile(content, skillFile));
    }
    return results;
}

/**
 * Load engine registry from available-agents.json.
 */
export function loadEngineRegistry(workspacePath: string): EngineRegistry {
    const configPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
    if (!fs.existsSync(configPath)) return {};

    try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const registry: EngineRegistry = {};
        if (data.engines && typeof data.engines === 'object') {
            for (const [engine, config] of Object.entries(data.engines)) {
                const c = config as Record<string, unknown>;
                registry[engine] = Array.isArray(c.available_models) ? c.available_models as string[] : [];
            }
        }
        return registry;
    } catch {
        return {};
    }
}

/**
 * Cross-validate all roles against the engine registry.
 */
export function lintRoleEngineConsistency(workspacePath: string): LintIssue[] {
    const registry = loadEngineRegistry(workspacePath);
    if (Object.keys(registry).length === 0) return [];

    const rolesDir = path.join(workspacePath, '.optimus', 'roles');
    if (!fs.existsSync(rolesDir)) return [];

    const issues: LintIssue[] = [];
    for (const file of fs.readdirSync(rolesDir)) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(rolesDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = parseFrontmatter(content);
        if (!parsed?.meta.engine) continue;
        issues.push(...lintEngineModel(parsed.meta.engine, parsed.meta.model, registry, filePath));
    }
    return issues;
}

/**
 * Run full workspace lint — roles, skills, and cross-validation.
 * Returns a summary with total issues by severity.
 */
export function lintWorkspace(workspacePath: string): {
    results: LintResult[];
    crossIssues: LintIssue[];
    summary: { errors: number; warnings: number; info: number; totalFiles: number };
} {
    const roleResults = lintAllRoles(workspacePath);
    const skillResults = lintAllSkills(workspacePath);
    const crossIssues = lintRoleEngineConsistency(workspacePath);
    const results = [...roleResults, ...skillResults];

    const allIssues = [...results.flatMap(r => r.issues), ...crossIssues];
    return {
        results,
        crossIssues,
        summary: {
            errors: allIssues.filter(i => i.severity === 'error').length,
            warnings: allIssues.filter(i => i.severity === 'warning').length,
            info: allIssues.filter(i => i.severity === 'info').length,
            totalFiles: results.length,
        },
    };
}
