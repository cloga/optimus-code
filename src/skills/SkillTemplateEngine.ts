import * as fs from 'fs';
import * as path from 'path';

/**
 * Context available to skill templates at render time.
 * These values are injected from the task execution environment.
 */
export interface SkillContext {
    /** Agent role name (e.g., "backend-dev", "security") */
    role: string;
    /** Execution engine (e.g., "claude-code", "github-copilot") */
    engine: string;
    /** Model name (e.g., "claude-opus-4.6") */
    model: string;
    /** OS platform (e.g., "win32", "linux", "darwin") */
    platform: string;
    /** Workspace root path */
    workspacePath: string;
    /** Additional custom variables */
    [key: string]: string;
}

/**
 * Check if content contains any template directives.
 * Used for fast-path: skip processing entirely for static skills.
 */
export function hasTemplateSyntax(content: string): boolean {
    return /\{\{[^}]+\}\}/.test(content) || /\{%[^%]+%\}/.test(content);
}

/**
 * Lightweight template engine for SKILL.md files.
 * 
 * Supports:
 * - Variable substitution: {{role}}, {{engine}}, {{model}}, {{platform}}, {{workspacePath}}
 * - Conditionals: {% if engine == "claude-code" %}...{% endif %}
 * - If/else: {% if platform == "win32" %}...{% else %}...{% endif %}
 * - Include: {% include "./references/file.md" %} (relative to skillDir)
 * 
 * Design principles:
 * - Zero overhead for static skills (fast-path when no template tags detected)
 * - Unknown variables are left as-is (safe for forward compatibility)
 * - Errors in template processing are caught and logged, never crash
 * - Backward compatible: existing SKILL.md files work unchanged
 */
export function renderSkillTemplate(
    content: string,
    context: SkillContext,
    skillDir?: string
): string {
    // Fast path: no template syntax detected
    if (!hasTemplateSyntax(content)) {
        return content;
    }

    try {
        let result = content;

        // Phase 1: Process includes (before variable substitution)
        result = processIncludes(result, context, skillDir);

        // Phase 2: Process conditionals (before variable substitution so conditions use raw values)
        result = processConditionals(result, context);

        // Phase 3: Variable substitution
        result = substituteVariables(result, context);

        return result;
    } catch (err) {
        // Template errors should never prevent skill loading
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SkillTemplate] Template processing error: ${msg}`);
        // Fall back to raw content with variables substituted
        return substituteVariables(content, context);
    }
}

/**
 * Substitute {{variable}} placeholders with context values.
 * Unknown variables are left as-is.
 */
function substituteVariables(content: string, context: SkillContext): string {
    return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, varName) => {
        const value = context[varName];
        if (value !== undefined && value !== null) {
            return String(value);
        }
        // Leave unknown variables as-is for forward compatibility
        return match;
    });
}

/**
 * Process {% if condition %}...{% else %}...{% endif %} blocks.
 * Supports: {% if variable == "value" %} and {% if variable != "value" %}
 * Supports nesting.
 */
function processConditionals(content: string, context: SkillContext): string {
    // Process from innermost to outermost (handle nesting)
    let result = content;
    let maxIterations = 50; // Safety limit for nested conditionals

    while (maxIterations-- > 0) {
        // Match innermost if/else/endif (no nested {% if inside)
        const ifElsePattern = /\{%\s*if\s+(\w+)\s*(==|!=)\s*"([^"]*)"\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/;
        const ifOnlyPattern = /\{%\s*if\s+(\w+)\s*(==|!=)\s*"([^"]*)"\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/;

        const elseMatch = result.match(ifElsePattern);
        if (elseMatch) {
            const [fullMatch, varName, operator, compareValue, trueBranch, falseBranch] = elseMatch;
            const actualValue = context[varName] ?? '';
            const conditionMet = operator === '=='
                ? actualValue === compareValue
                : actualValue !== compareValue;
            result = result.replace(fullMatch, conditionMet ? trueBranch : falseBranch);
            continue;
        }

        const ifMatch = result.match(ifOnlyPattern);
        if (ifMatch) {
            const [fullMatch, varName, operator, compareValue, trueBranch] = ifMatch;
            const actualValue = context[varName] ?? '';
            const conditionMet = operator === '=='
                ? actualValue === compareValue
                : actualValue !== compareValue;
            result = result.replace(fullMatch, conditionMet ? trueBranch : '');
            continue;
        }

        // No more conditionals found
        break;
    }

    return result;
}

/**
 * Process {% include "./path/to/file.md" %} directives.
 * Paths are relative to the skill directory.
 * Missing files are replaced with a warning comment.
 */
function processIncludes(content: string, context: SkillContext, skillDir?: string): string {
    if (!skillDir) return content;

    return content.replace(
        /\{%\s*include\s+"([^"]+)"\s*%\}/g,
        (match, includePath) => {
            try {
                const resolvedPath = path.resolve(skillDir, includePath);
                // Security: ensure included file is within skill directory
                const normalizedSkillDir = path.resolve(skillDir);
                if (!resolvedPath.startsWith(normalizedSkillDir)) {
                    console.error(`[SkillTemplate] Include path escapes skill directory: ${includePath}`);
                    return `<!-- Include rejected: path escapes skill directory -->`;
                }
                if (!fs.existsSync(resolvedPath)) {
                    return `<!-- Include not found: ${includePath} -->`;
                }
                let included = fs.readFileSync(resolvedPath, 'utf8');
                // Recursively process includes in the included file (max depth handled by caller's iteration limit)
                included = processIncludes(included, context, path.dirname(resolvedPath));
                return included;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[SkillTemplate] Include error for "${includePath}": ${msg}`);
                return `<!-- Include error: ${includePath} -->`;
            }
        }
    );
}

/**
 * Build a SkillContext from the available execution environment.
 * Convenience helper for worker-spawner integration.
 */
export function buildSkillContext(
    role: string,
    engine: string,
    model: string,
    workspacePath: string,
    extras?: Record<string, string>
): SkillContext {
    return {
        role,
        engine,
        model,
        platform: process.platform,
        workspacePath,
        ...extras,
    };
}
