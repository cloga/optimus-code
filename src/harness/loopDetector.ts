/**
 * Doom Loop Detector — Harness Engineering
 *
 * Detects when an agent repeatedly edits the same file(s), which
 * indicates it's stuck in a loop making small variations to a broken approach.
 *
 * Inspired by LangChain's LoopDetectionMiddleware.
 */

export interface LoopWarning {
    files: { path: string; count: number }[];
    suggestion: string;
}

// In-memory per-session edit tracking
const sessionEdits = new Map<string, Map<string, number>>();

/**
 * Record a file edit for a given session.
 */
export function trackFileEdit(sessionId: string, filePath: string): void {
    if (!sessionEdits.has(sessionId)) {
        sessionEdits.set(sessionId, new Map());
    }
    const edits = sessionEdits.get(sessionId)!;
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    edits.set(normalized, (edits.get(normalized) || 0) + 1);
}

/**
 * Get the edit count for a specific file in a session.
 */
export function getEditCount(sessionId: string, filePath: string): number {
    const edits = sessionEdits.get(sessionId);
    if (!edits) return 0;
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return edits.get(normalized) || 0;
}

/**
 * Check if any file has been edited more than `threshold` times.
 * Returns a warning if a potential doom loop is detected.
 */
export function checkForLoop(sessionId: string, threshold = 3): LoopWarning | null {
    const edits = sessionEdits.get(sessionId);
    if (!edits) return null;

    const hotFiles: { path: string; count: number }[] = [];
    for (const [path, count] of edits) {
        if (count >= threshold) {
            hotFiles.push({ path, count });
        }
    }

    if (hotFiles.length === 0) return null;

    hotFiles.sort((a, b) => b.count - a.count);

    const fileList = hotFiles.map(f => `${f.path} (${f.count}x)`).join(', ');
    return {
        files: hotFiles,
        suggestion:
            `⚠️ Potential doom loop detected: ${fileList}. ` +
            `You've edited the same file(s) multiple times. Consider stepping back ` +
            `and reconsidering your approach — the current strategy may not be working.`,
    };
}

/**
 * Scan agent output text for file edit patterns (tool_use calls to write/edit tools).
 * Returns a list of file paths that were edited.
 */
export function extractEditedFiles(output: string): string[] {
    const files = new Set<string>();

    // Pattern 1: MCP tool calls — edit_file, write_file, create_file
    const toolPatterns = [
        /(?:edit_file|write_file|create_file|str_replace_editor)\s*[({][\s\S]*?(?:path|file_path|file)\s*[:=]\s*["']([^"']+)["']/gi,
        // Pattern 2: Direct file write operations in shell
        /(?:writeFileSync|writeFile)\s*\(\s*["']([^"']+)["']/g,
        // Pattern 3: Redirect/pipe to file
        />\s*["']?([^\s"'|&;]+\.\w{1,10})["']?/g,
    ];

    for (const pattern of toolPatterns) {
        let match;
        while ((match = pattern.exec(output)) !== null) {
            const filePath = match[1];
            // Filter out obvious non-file patterns
            if (filePath && filePath.length > 2 && filePath.includes('.')) {
                files.add(filePath);
            }
        }
    }

    return Array.from(files);
}

/**
 * Full analysis: extract edited files from output, track them, check for loops.
 */
export function analyzeOutputForLoops(
    sessionId: string,
    output: string,
    threshold = 3
): LoopWarning | null {
    const files = extractEditedFiles(output);
    for (const f of files) {
        trackFileEdit(sessionId, f);
    }
    return checkForLoop(sessionId, threshold);
}

/**
 * Clean up session tracking data.
 */
export function clearSession(sessionId: string): void {
    sessionEdits.delete(sessionId);
}

/**
 * Get all tracked sessions (for debugging/monitoring).
 */
export function getTrackedSessions(): string[] {
    return Array.from(sessionEdits.keys());
}
