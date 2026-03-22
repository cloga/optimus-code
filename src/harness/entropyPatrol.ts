/**
 * Entropy Patrol — Harness Engineering
 *
 * Periodic consistency checks that run via meta-cron.
 * Detects drift between config, roles, skills, and actual codebase state.
 *
 * Inspired by OpenAI's "Garbage Collection" agents that fight entropy.
 */

import fs from 'fs';
import path from 'path';
import {
    lintWorkspace,
    loadEngineRegistry,
    parseFrontmatter,
    LintIssue,
} from './mechanicalLinter';

export interface PatrolReport {
    timestamp: string;
    checks: PatrolCheck[];
    summary: { passed: number; warnings: number; errors: number };
}

export interface PatrolCheck {
    name: string;
    status: 'pass' | 'warn' | 'error';
    details: string;
}

/**
 * Check 1: Lint all roles and skills for structural validity.
 */
function checkStructuralLint(workspacePath: string): PatrolCheck[] {
    const { summary, crossIssues, results } = lintWorkspace(workspacePath);
    const checks: PatrolCheck[] = [];

    if (summary.errors > 0) {
        const errorFiles = results.filter(r => !r.passed).map(r => path.basename(r.file));
        checks.push({
            name: 'structural-lint',
            status: 'error',
            details: `${summary.errors} error(s) in ${summary.totalFiles} files: ${errorFiles.join(', ')}`,
        });
    } else if (summary.warnings > 0) {
        checks.push({
            name: 'structural-lint',
            status: 'warn',
            details: `${summary.warnings} warning(s) across ${summary.totalFiles} files.`,
        });
    } else {
        checks.push({
            name: 'structural-lint',
            status: 'pass',
            details: `${summary.totalFiles} files checked, all clean.`,
        });
    }

    if (crossIssues.length > 0) {
        checks.push({
            name: 'engine-model-consistency',
            status: crossIssues.some(i => i.severity === 'error') ? 'error' : 'warn',
            details: crossIssues.map(i => i.message).join('; '),
        });
    }

    return checks;
}

/**
 * Check 2: Detect stale T1 agent instances (older than `maxAgeDays`).
 */
function checkStaleAgents(workspacePath: string, maxAgeDays = 7): PatrolCheck {
    const agentsDir = path.join(workspacePath, '.optimus', 'agents');
    if (!fs.existsSync(agentsDir)) {
        return { name: 'stale-agents', status: 'pass', details: 'No agents directory found.' };
    }

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const staleAgents: string[] = [];

    for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(agentsDir, file);
        try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
                staleAgents.push(file);
            }
        } catch { /* skip unreadable */ }
    }

    if (staleAgents.length === 0) {
        return { name: 'stale-agents', status: 'pass', details: 'No stale T1 instances found.' };
    }

    return {
        name: 'stale-agents',
        status: 'warn',
        details: `${staleAgents.length} T1 instance(s) older than ${maxAgeDays} days: ${staleAgents.slice(0, 5).join(', ')}${staleAgents.length > 5 ? '...' : ''}`,
    };
}

/**
 * Check 3: Detect orphaned skills (referenced by roles but missing on disk).
 */
function checkOrphanedSkills(workspacePath: string): PatrolCheck {
    const skillsDir = path.join(workspacePath, '.optimus', 'skills');
    const rolesDir = path.join(workspacePath, '.optimus', 'roles');
    if (!fs.existsSync(skillsDir) || !fs.existsSync(rolesDir)) {
        return { name: 'orphaned-skills', status: 'pass', details: 'Skills or roles directory not found.' };
    }

    // Collect existing skill names
    const existingSkills = new Set<string>();
    for (const dir of fs.readdirSync(skillsDir)) {
        const skillFile = path.join(skillsDir, dir, 'SKILL.md');
        if (fs.existsSync(skillFile)) existingSkills.add(dir);
    }

    // Scan role templates for referenced skills
    const referencedSkills = new Set<string>();
    for (const file of fs.readdirSync(rolesDir)) {
        if (!file.endsWith('.md')) continue;
        const content = fs.readFileSync(path.join(rolesDir, file), 'utf8');
        // Look for skill references in role body
        const skillRefs = content.match(/required_skills.*?\[([^\]]+)\]/g);
        if (skillRefs) {
            for (const ref of skillRefs) {
                const names = ref.match(/"([^"]+)"/g);
                if (names) names.forEach(n => referencedSkills.add(n.replace(/"/g, '')));
            }
        }
    }

    const missing = [...referencedSkills].filter(s => !existingSkills.has(s));
    if (missing.length === 0) {
        return { name: 'orphaned-skills', status: 'pass', details: `${existingSkills.size} skills present, no orphans.` };
    }

    return {
        name: 'orphaned-skills',
        status: 'warn',
        details: `${missing.length} skill(s) referenced but not found on disk: ${missing.join(', ')}`,
    };
}

/**
 * Check 4: Detect quarantined roles that may need attention.
 */
function checkQuarantinedRoles(workspacePath: string): PatrolCheck {
    const rolesDir = path.join(workspacePath, '.optimus', 'roles');
    if (!fs.existsSync(rolesDir)) {
        return { name: 'quarantined-roles', status: 'pass', details: 'No roles directory.' };
    }

    const quarantined: string[] = [];
    for (const file of fs.readdirSync(rolesDir)) {
        if (!file.endsWith('.md')) continue;
        const content = fs.readFileSync(path.join(rolesDir, file), 'utf8');
        const parsed = parseFrontmatter(content);
        if (parsed?.meta.status === 'quarantined') {
            quarantined.push(parsed.meta.role || file);
        }
    }

    if (quarantined.length === 0) {
        return { name: 'quarantined-roles', status: 'pass', details: 'No quarantined roles.' };
    }

    return {
        name: 'quarantined-roles',
        status: 'warn',
        details: `${quarantined.length} role(s) quarantined: ${quarantined.join(', ')}. Review and fix or delete.`,
    };
}

/**
 * Check 5: Verify memory file is well-formed.
 */
function checkMemoryHealth(workspacePath: string): PatrolCheck {
    const memFile = path.join(workspacePath, '.optimus', 'memory', 'continuous-memory.md');
    if (!fs.existsSync(memFile)) {
        return { name: 'memory-health', status: 'pass', details: 'No memory file found.' };
    }

    try {
        const content = fs.readFileSync(memFile, 'utf8');
        const entryCount = (content.match(/^---$/gm) || []).length / 2; // pairs of ---

        if (content.length > 500_000) {
            return {
                name: 'memory-health',
                status: 'warn',
                details: `Memory file is very large (${(content.length / 1024).toFixed(0)} KB, ~${Math.round(entryCount)} entries). Consider pruning old entries.`,
            };
        }

        return {
            name: 'memory-health',
            status: 'pass',
            details: `Memory file OK (${(content.length / 1024).toFixed(0)} KB, ~${Math.round(entryCount)} entries).`,
        };
    } catch (e: any) {
        return {
            name: 'memory-health',
            status: 'error',
            details: `Failed to read memory file: ${e.message}`,
        };
    }
}

// ── Main Patrol Runner ──────────────────────────────────────────

/**
 * Run all entropy patrol checks on a workspace.
 * Designed to be called by meta-cron or manually via MCP tool.
 */
export function runEntropyPatrol(workspacePath: string): PatrolReport {
    const checks: PatrolCheck[] = [
        ...checkStructuralLint(workspacePath),
        checkStaleAgents(workspacePath),
        checkOrphanedSkills(workspacePath),
        checkQuarantinedRoles(workspacePath),
        checkMemoryHealth(workspacePath),
    ];

    const summary = {
        passed: checks.filter(c => c.status === 'pass').length,
        warnings: checks.filter(c => c.status === 'warn').length,
        errors: checks.filter(c => c.status === 'error').length,
    };

    return {
        timestamp: new Date().toISOString(),
        checks,
        summary,
    };
}

/**
 * Format patrol report as human-readable markdown.
 */
export function formatPatrolReport(report: PatrolReport): string {
    const lines: string[] = [
        `# 🔍 Entropy Patrol Report`,
        `**Date**: ${report.timestamp}`,
        `**Summary**: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.errors} errors`,
        '',
    ];

    for (const check of report.checks) {
        const icon = check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️' : '❌';
        lines.push(`${icon} **${check.name}**: ${check.details}`);
    }

    return lines.join('\n');
}
