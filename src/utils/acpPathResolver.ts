import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';

/**
 * Robust ACP executable path resolver.
 * 
 * Problem: The MCP server process inherits PATH from its launcher (VS Code, IDE),
 * which may not include directories where ACP tools are installed (e.g., npm global bin).
 * The standard `where`/`which` commands fail in this restricted PATH.
 * 
 * Solution: Multi-strategy resolution — tries standard PATH first, then scans
 * known installation directories for the executable.
 */

// Session-level cache: executable name → resolved absolute path
const resolvedPathCache = new Map<string, string | null>();

/**
 * Get common installation directories for npm global packages per platform.
 */
function getCommonInstallPaths(): string[] {
    const paths: string[] = [];
    const home = os.homedir();

    if (process.platform === 'win32') {
        // Windows npm global paths
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        paths.push(
            'C:\\.tools\\.npm-global',              // Custom npm prefix
            path.join(appData, 'npm'),                // Default npm global (Windows)
            path.join(localAppData, 'npm'),           // Alternative npm location
            path.join(home, '.npm-global', 'bin'),    // Custom npm prefix (user)
            path.join(home, 'AppData', 'Roaming', 'npm'),
        );
        // Also check Program Files for node installations
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        paths.push(path.join(programFiles, 'nodejs'));
    } else if (process.platform === 'darwin') {
        // macOS
        paths.push(
            '/usr/local/bin',
            '/opt/homebrew/bin',                      // Apple Silicon Homebrew
            path.join(home, '.npm-global', 'bin'),    // Custom npm prefix
            path.join(home, '.npm', 'bin'),            
            '/usr/local/lib/node_modules/.bin',
        );
    } else {
        // Linux
        paths.push(
            '/usr/local/bin',
            '/usr/bin',
            path.join(home, '.npm-global', 'bin'),
            path.join(home, '.local', 'bin'),
            path.join(home, '.npm', 'bin'),
            '/usr/local/lib/node_modules/.bin',
        );
    }

    return paths;
}

/**
 * Try to resolve an executable using the system PATH (where/which).
 * Returns the absolute path if found, null otherwise.
 */
function resolveViaSystemPath(executable: string): string | null {
    try {
        const cmd = process.platform === 'win32' ? `where ${executable}` : `which ${executable}`;
        const result = cp.execSync(cmd, { stdio: 'pipe', timeout: 5000, encoding: 'utf8' });
        const resolved = result.trim().split(/\r?\n/)[0]; // Take first match
        if (resolved && fs.existsSync(resolved)) {
            return resolved;
        }
    } catch {
        // Not found in PATH
    }
    return null;
}

/**
 * Try to find an executable in common installation directories.
 * Checks for the executable name with platform-appropriate extensions.
 */
function resolveViaCommonPaths(executable: string): string | null {
    const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe', '.ps1'] : [''];
    const dirs = getCommonInstallPaths();

    for (const dir of dirs) {
        for (const ext of extensions) {
            const candidate = path.join(dir, executable + ext);
            try {
                if (fs.existsSync(candidate)) {
                    // Verify it's actually executable (not a directory)
                    const stat = fs.statSync(candidate);
                    if (stat.isFile()) {
                        return candidate;
                    }
                }
            } catch {
                // Skip inaccessible paths
            }
        }
    }
    return null;
}

/**
 * Resolve an ACP executable to an absolute path using multi-strategy lookup.
 * 
 * Strategy order:
 * 1. If already an absolute path and exists → return as-is
 * 2. Try system PATH (where/which) 
 * 3. Scan common npm/node installation directories
 * 4. Return null if not found anywhere
 * 
 * Results are cached for the session lifetime.
 * 
 * @param executable - Executable name or path (e.g., "claude-agent-acp", "copilot")
 * @returns Absolute path to executable, or null if not found
 */
export function resolveExecutablePath(executable: string): string | null {
    // Check cache first
    if (resolvedPathCache.has(executable)) {
        return resolvedPathCache.get(executable) ?? null;
    }

    let resolved: string | null = null;

    // Strategy 1: Already absolute and exists
    if (path.isAbsolute(executable)) {
        if (fs.existsSync(executable)) {
            resolved = executable;
        }
        // On Windows, try with .cmd extension
        if (!resolved && process.platform === 'win32') {
            for (const ext of ['.cmd', '.exe']) {
                if (fs.existsSync(executable + ext)) {
                    resolved = executable + ext;
                    break;
                }
            }
        }
    }

    // Strategy 2: System PATH lookup
    if (!resolved) {
        resolved = resolveViaSystemPath(executable);
        if (resolved) {
            console.error(`[AcpPathResolver] Found '${executable}' via PATH: ${resolved}`);
        }
    }

    // Strategy 3: Common installation paths scan
    if (!resolved) {
        resolved = resolveViaCommonPaths(executable);
        if (resolved) {
            console.error(`[AcpPathResolver] Found '${executable}' via common-path scan: ${resolved}`);
        }
    }

    // Cache result (including null for negative cache)
    resolvedPathCache.set(executable, resolved);

    if (!resolved) {
        console.error(`[AcpPathResolver] '${executable}' not found in PATH or common install locations`);
    }

    return resolved;
}

/**
 * Clear the resolution cache (for testing or after PATH changes).
 */
export function clearResolvedPathCache(): void {
    resolvedPathCache.clear();
}

/**
 * Get all common installation paths for the current platform (for diagnostics).
 */
export function getCommonInstallPathsForPlatform(): string[] {
    return getCommonInstallPaths();
}

/**
 * Build a diagnostic report for executable resolution (for error messages).
 */
export function buildResolutionDiagnostic(executable: string): string {
    const lines: string[] = [
        `Executable: ${executable}`,
        `Platform: ${process.platform}`,
        `PATH entries: ${(process.env.PATH || '').split(path.delimiter).length}`,
        `Common paths checked:`,
    ];
    for (const dir of getCommonInstallPaths()) {
        const exists = fs.existsSync(dir) ? '✅' : '❌';
        lines.push(`  ${exists} ${dir}`);
    }
    return lines.join('\n');
}
