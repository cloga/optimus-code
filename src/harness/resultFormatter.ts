import * as fs from 'fs';
import { TaskDelegationResult } from '../types/TaskDelegationResult.js';

/** Metadata needed to construct a TaskDelegationResult */
export interface TaskResultMetadata {
    taskId: string;
    role: string;
    engine: string;
    model?: string;
    outputPath: string;
    tierResolved: 'T1' | 'T2' | 'T3';
    sessionId?: string;
}

/**
 * Determine task status based on execution result quality.
 */
export function determineTaskStatus(
    output: string,
    parseError?: string,
    validationWarnings?: string[]
): 'success' | 'partial' | 'failed' {
    if (parseError) return 'failed';
    if (!output || output.trim().length < 20) return 'failed';
    if (validationWarnings && validationWarnings.length > 0) return 'partial';
    return 'success';
}

/**
 * Clean a raw output string for use as a summary.
 * Strips control characters and truncates to maxLength.
 */
function cleanSummary(output: string, maxLength: number = 500): string {
    if (!output) return '';
    // Strip ANSI escape codes and control chars (except newline/tab)
    const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.slice(0, maxLength) + '…';
}

/**
 * Get file size safely, returning 0 if file doesn't exist.
 */
function getFileSizeBytes(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

/**
 * Extract a structured TaskDelegationResult from raw execution data.
 *
 * @param execResult - The result from executePrompt() (or equivalent data)
 * @param metadata - Task metadata (role, engine, paths, etc.)
 * @param startTime - Date.now() timestamp when execution started
 */
export function extractTaskResult(
    execResult: {
        output: string;
        parsed?: unknown;
        parseError?: string;
        validationWarnings?: string[];
        sessionId?: string;
        stopReason?: string;
        usage?: Record<string, unknown>;
        durationMs?: number;
    },
    metadata: TaskResultMetadata,
    startTime: number
): TaskDelegationResult {
    const executionTimeMs = execResult.durationMs ?? (Date.now() - startTime);
    const outputSizeBytes = getFileSizeBytes(metadata.outputPath) || Buffer.byteLength(execResult.output || '', 'utf8');

    const status = determineTaskStatus(
        execResult.output,
        execResult.parseError,
        execResult.validationWarnings
    );

    const errors: string[] = [];
    if (execResult.parseError) errors.push(execResult.parseError);
    if (!execResult.output || execResult.output.trim().length < 20) {
        errors.push('Output is empty or too short');
    }

    return {
        status,
        task_id: metadata.taskId,
        role: metadata.role,
        engine: metadata.engine,
        model: metadata.model,
        session_id: execResult.sessionId ?? metadata.sessionId,
        output_path: metadata.outputPath,
        output_size_bytes: outputSizeBytes,
        summary: cleanSummary(execResult.output),
        usage: {
            input_tokens: execResult.usage?.input_tokens as number | undefined,
            output_tokens: execResult.usage?.output_tokens as number | undefined,
            total_tokens: execResult.usage?.total_tokens as number | undefined,
        },
        execution_time_ms: executionTimeMs,
        stop_reason: execResult.stopReason,
        validation_warnings: execResult.validationWarnings,
        tier_resolved: metadata.tierResolved,
        timestamp: new Date().toISOString(),
        errors: errors.length > 0 ? errors : undefined,
    };
}
