/**
 * Structured result returned by delegateTaskSingle() after task execution.
 * Replaces the previous plain-text markdown return format.
 */
export interface TaskDelegationResult {
    /** Execution outcome */
    status: 'success' | 'partial' | 'failed';
    /** Unique task identifier */
    task_id: string;
    /** Role that executed the task */
    role: string;
    /** Engine used for execution */
    engine: string;
    /** Model used for execution */
    model?: string;
    /** Session ID for potential reuse */
    session_id?: string;
    /** Path where agent output was written */
    output_path: string;
    /** Size of the output file in bytes */
    output_size_bytes: number;
    /** First 500 chars of agent output (cleaned) */
    summary: string;
    /** Token usage from the LLM */
    usage: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
    };
    /** Wall-clock execution time in milliseconds */
    execution_time_ms: number;
    /** LLM stop reason (e.g., "end_turn") */
    stop_reason?: string;
    /** Validation warnings from the harness */
    validation_warnings?: string[];
    /** Which tier was resolved (T1=instance, T2=template, T3=zero-shot) */
    tier_resolved: 'T1' | 'T2' | 'T3';
    /** ISO 8601 timestamp of completion */
    timestamp: string;
    /** Error messages if status is 'failed' */
    errors?: string[];
}

/**
 * Format a TaskDelegationResult as a human-readable markdown text.
 * Used for MCP backward compatibility where callers expect text responses.
 */
export function formatTaskResultAsText(result: TaskDelegationResult): string {
    const statusIcon = result.status === 'success' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
    const lines = [
        `${statusIcon} **Task Delegation ${result.status === 'success' ? 'Successful' : result.status === 'partial' ? 'Partial' : 'Failed'}**`,
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| Status | ${result.status} |`,
        `| Task ID | \`${result.task_id}\` |`,
        `| Role | ${result.role} |`,
        `| Engine | ${result.engine}${result.model ? ` / ${result.model}` : ''} |`,
        `| Tier | ${result.tier_resolved} |`,
        `| Tokens | ${result.usage.total_tokens ?? 'N/A'} |`,
        `| Time | ${result.execution_time_ms}ms |`,
        `| Output | \`${result.output_path}\` (${result.output_size_bytes} bytes) |`,
    ];

    if (result.session_id) {
        lines.push(`| Session | \`${result.session_id}\` |`);
    }

    lines.push('');

    if (result.summary) {
        lines.push(`**Summary**`, '', result.summary);
    }

    if (result.validation_warnings && result.validation_warnings.length > 0) {
        lines.push('', `**Warnings**`);
        for (const w of result.validation_warnings) {
            lines.push(`- ${w}`);
        }
    }

    if (result.errors && result.errors.length > 0) {
        lines.push('', `**Errors**`);
        for (const e of result.errors) {
            lines.push(`- ${e}`);
        }
    }

    return lines.join('\n');
}
