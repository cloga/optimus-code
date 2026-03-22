/**
 * Output Validation Gate — Harness Engineering
 *
 * Validates agent output BEFORE it's written to artifact files.
 * Catches: empty output, schema violations, premature completion,
 * unfinished code, and error leaks.
 *
 * Inspired by LangChain's PreCompletionChecklistMiddleware.
 */

export interface ValidationContext {
    role: string;
    outputSchema?: object;
    taskDescription?: string;
    outputPath: string;
    engine: string;
    /** 'strict' rejects on warnings too; 'normal' only rejects on failures; 'skip' disables */
    verificationLevel?: 'strict' | 'normal' | 'skip';
}

export interface ValidationIssue {
    rule: string;
    message: string;
    severity: 'fail' | 'warn';
}

export interface ValidationResult {
    valid: boolean;
    issues: ValidationIssue[];
    severity: 'pass' | 'warn' | 'fail';
}

// ── Built-in Rules ──────────────────────────────────────────────

function checkEmptyOutput(output: string): ValidationIssue | null {
    const trimmed = output.trim();
    if (trimmed.length === 0) {
        return { rule: 'empty-output', message: 'Agent produced empty output.', severity: 'fail' };
    }
    if (trimmed.length < 20) {
        return { rule: 'empty-output', message: `Agent output suspiciously short (${trimmed.length} chars).`, severity: 'warn' };
    }
    return null;
}

function checkSchemaCompliance(output: string, schema: object | undefined): ValidationIssue | null {
    if (!schema) return null;

    // Try to parse as JSON
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch {
        // Try code fence extraction
        const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (fenceMatch) {
            try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
        }
        // Try brace matching
        if (parsed === undefined) {
            const braceStart = output.indexOf('{');
            const braceEnd = output.lastIndexOf('}');
            if (braceStart !== -1 && braceEnd > braceStart) {
                try { parsed = JSON.parse(output.slice(braceStart, braceEnd + 1)); } catch { /* fall through */ }
            }
        }
    }

    if (parsed === undefined) {
        return {
            rule: 'schema-compliance',
            message: 'output_schema specified but agent output is not valid JSON.',
            severity: 'fail',
        };
    }

    // Basic structural check: if schema requires certain properties, verify they exist
    const s = schema as Record<string, unknown>;
    if (s.required && Array.isArray(s.required) && typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        const missing = (s.required as string[]).filter(k => !(k in obj));
        if (missing.length > 0) {
            return {
                rule: 'schema-compliance',
                message: `JSON missing required fields: ${missing.join(', ')}`,
                severity: 'fail',
            };
        }
    }

    return null;
}

const PREMATURE_PATTERNS = [
    /^(I'?ve|I have) (completed|finished|done with) (the|this|all) (task|work|request)/im,
    /^(Task|Work) (is )?(complete|done|finished)/im,
    /^(Everything|All) (is |has been )?(completed|done|finished)/im,
];

function checkPrematureCompletion(output: string): ValidationIssue | null {
    const trimmed = output.trim();
    // Only flag if the output is very short AND matches a "done" pattern
    if (trimmed.length > 200) return null;

    for (const pattern of PREMATURE_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                rule: 'premature-completion',
                message: 'Agent declared task complete but output has no substantive content.',
                severity: 'warn',
            };
        }
    }
    return null;
}

const UNFINISHED_MARKERS = [
    /\bTODO\b/,
    /\bFIXME\b/,
    /\bHACK\b/,
    /\bXXX\b/,
    /\.{3}\s*$/m,           // trailing "..." suggesting incomplete
    /\/\/ \.\.\./,           // comment with just "..."
    /\bplaceholder\b/i,
];

function checkUnfinishedCode(output: string): ValidationIssue | null {
    const matches: string[] = [];
    for (const marker of UNFINISHED_MARKERS) {
        if (marker.test(output)) {
            const match = output.match(marker);
            if (match) matches.push(match[0]);
        }
    }
    if (matches.length >= 2) {
        return {
            rule: 'unfinished-code',
            message: `Output contains unfinished markers: ${matches.slice(0, 3).join(', ')}`,
            severity: 'warn',
        };
    }
    return null;
}

const ERROR_PATTERNS = [
    /^Traceback \(most recent call last\)/m,
    /^Error: .{10,}/m,
    /^Unhandled(Promise)?Rejection/m,
    /at Object\.<anonymous> \(.+:\d+:\d+\)/,
    /^FATAL ERROR:/m,
    /^panic: /m,
];

function checkErrorLeak(output: string): ValidationIssue | null {
    for (const pattern of ERROR_PATTERNS) {
        if (pattern.test(output)) {
            return {
                rule: 'error-leak',
                message: 'Output contains error traces that may indicate execution failure.',
                severity: 'warn',
            };
        }
    }
    return null;
}

// ── Main Validator ──────────────────────────────────────────────

export function validateOutput(output: string, context: ValidationContext): ValidationResult {
    if (context.verificationLevel === 'skip') {
        return { valid: true, issues: [], severity: 'pass' };
    }

    const issues: ValidationIssue[] = [];

    const checks = [
        checkEmptyOutput(output),
        checkSchemaCompliance(output, context.outputSchema),
        checkPrematureCompletion(output),
        checkUnfinishedCode(output),
        checkErrorLeak(output),
    ];

    for (const issue of checks) {
        if (issue) issues.push(issue);
    }

    const hasFail = issues.some(i => i.severity === 'fail');
    const hasWarn = issues.some(i => i.severity === 'warn');

    let severity: 'pass' | 'warn' | 'fail';
    if (hasFail) {
        severity = 'fail';
    } else if (hasWarn && context.verificationLevel === 'strict') {
        severity = 'fail';
    } else if (hasWarn) {
        severity = 'warn';
    } else {
        severity = 'pass';
    }

    return {
        valid: severity !== 'fail',
        issues,
        severity,
    };
}

/**
 * Format validation issues as a human-readable string for error messages.
 */
export function formatValidationIssues(issues: ValidationIssue[]): string {
    return issues
        .map(i => `- [${i.severity.toUpperCase()}] ${i.rule}: ${i.message}`)
        .join('\n');
}
