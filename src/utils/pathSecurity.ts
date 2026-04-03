/**
 * Advanced path security checks, inspired by Claude Code's multi-layer
 * path validation. Catches attacks that bypass basic path.resolve() checks.
 */

/**
 * Reject paths containing null bytes.
 * Null bytes can truncate path strings in C-based syscalls (fs.open, etc.),
 * allowing access to files outside the intended directory.
 *
 * @throws Error if path contains null bytes
 */
export function rejectNullBytes(filePath: string): void {
    if (filePath.includes('\x00')) {
        throw new Error(
            `Path security violation: null byte detected in path. ` +
            `This may be an attempt to truncate the path at the OS level.`
        );
    }
}

/**
 * Reject paths containing URL-encoded traversal sequences.
 * Attackers may use %2e%2e%2f (../) or %2e%2e%5c (..\) to bypass
 * string-level path checks before the path is decoded by the OS.
 *
 * @throws Error if URL-encoded traversal is detected
 */
export function rejectUrlEncodedTraversal(filePath: string): void {
    let decoded: string;
    try {
        decoded = decodeURIComponent(filePath);
    } catch {
        // Invalid encoding is suspicious but not necessarily malicious
        return;
    }

    if (decoded !== filePath && (decoded.includes('..') || decoded.includes('./'))) {
        throw new Error(
            `Path security violation: URL-encoded traversal detected. ` +
            `Raw: "${filePath.slice(0, 50)}", Decoded contains traversal sequences.`
        );
    }
}

/**
 * Reject paths containing Unicode characters that normalize to path separators
 * or dot-dot sequences. Fullwidth characters (U+FF0E = ．, U+FF0F = ／, U+FF3C = ＼)
 * can normalize to ASCII equivalents on some filesystems.
 *
 * @throws Error if dangerous Unicode characters are detected
 */
export function rejectUnicodeTraversal(filePath: string): void {
    // Fullwidth period: U+FF0E (．)
    // Fullwidth solidus: U+FF0F (／)
    // Fullwidth reverse solidus: U+FF3C (＼)
    // One dot leader: U+2024
    // Two dot leader: U+2025
    // Small full stop: U+FE52
    // Small reverse solidus: U+FE68
    const dangerousChars = /[\uFF0E\uFF0F\uFF3C\u2024\u2025\uFE52\uFE68]/;

    if (dangerousChars.test(filePath)) {
        throw new Error(
            `Path security violation: Unicode characters detected that may normalize ` +
            `to path separators or dots (fullwidth ．／＼ etc.). Use ASCII paths only.`
        );
    }
}

/**
 * Normalize path casing for comparison on case-insensitive filesystems (Windows/macOS).
 * Prevents bypasses like ".Optimus/" vs ".optimus/" or ".Claude/" vs ".claude/".
 */
export function normalizeCaseForComparison(filePath: string): string {
    if (process.platform === 'win32' || process.platform === 'darwin') {
        return filePath.toLowerCase();
    }
    return filePath;
}

/**
 * Run all path security checks. Call this before any fs operation on user-influenced paths.
 *
 * @throws Error if any security check fails
 */
export function validatePathSecurity(filePath: string): void {
    rejectNullBytes(filePath);
    rejectUrlEncodedTraversal(filePath);
    rejectUnicodeTraversal(filePath);
}
