/**
 * MemoryManager — Multi-Level Memory System
 *
 * Owns all memory loading, parsing, scoring, and migration logic.
 * Supports project-level and role-level memory scopes with
 * priority-based filtering within a token budget.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { sanitizeExternalContent } from '../utils/sanitizeExternalContent';
import { resolveOptimusPath } from '../utils/worktree';
import { validatePathSecurity, normalizeCaseForComparison, rejectNullBytes } from '../utils/pathSecurity';

// ─── Types ───

export interface MemoryEntry {
    id: string;
    date: string;
    level: 'project' | 'role';
    category: string;
    tags: string[];
    author: string;
    body: string;
}

// ─── Role Name Sanitization (mirrors worker-spawner.ts:68-70) ───

function sanitizeRoleName(role: string): string {
    rejectNullBytes(role);
    return role.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100);
}

// ─── YAML Frontmatter Parser ───

/**
 * Parse multi-document markdown with YAML frontmatter blocks.
 * Each entry is delimited by paired `---` lines. Text without
 * frontmatter is wrapped as a legacy entry.
 *
 * Never throws — malformed entries are skipped or wrapped as legacy.
 */
export function parseMemoryEntries(content: string): MemoryEntry[] {
    if (content === undefined || content === null) return [];
    const trimmed = content.trim();
    if (!trimmed) return [];

    const entries: MemoryEntry[] = [];
    const lines = trimmed.split('\n');
    let i = 0;

    // Collect unstructured text that appears before/between frontmatter blocks
    let unstructuredBuffer: string[] = [];

    function flushUnstructured(): void {
        const text = unstructuredBuffer.join('\n').trim();
        if (text) {
            entries.push({
                id: 'legacy_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                date: new Date().toISOString(),
                level: 'project',
                category: 'legacy',
                tags: ['unstructured'],
                author: 'system',
                body: text,
            });
        }
        unstructuredBuffer = [];
    }

    while (i < lines.length) {
        // Check for frontmatter opening delimiter
        if (lines[i].trim() === '---') {
            const fmStart = i + 1;
            // Find closing delimiter
            let fmEnd = -1;
            for (let j = fmStart; j < lines.length; j++) {
                if (lines[j].trim() === '---') {
                    fmEnd = j;
                    break;
                }
            }

            if (fmEnd === -1) {
                // No closing delimiter — treat rest as unstructured
                unstructuredBuffer.push(lines[i]);
                i++;
                continue;
            }

            // Try to parse the frontmatter as YAML key-value pairs
            const fmLines = lines.slice(fmStart, fmEnd);
            const parsed = parseSimpleYaml(fmLines);

            if (parsed === null) {
                // Not valid YAML key-value — treat as unstructured text
                unstructuredBuffer.push(lines[i]);
                i++;
                continue;
            }

            // Flush any preceding unstructured text as a legacy entry
            flushUnstructured();

            // Collect body text until next frontmatter block or EOF
            let bodyStart = fmEnd + 1;
            let bodyEnd = bodyStart;
            while (bodyEnd < lines.length) {
                // Look ahead for next frontmatter opening
                if (lines[bodyEnd].trim() === '---') {
                    // Check if this is the start of a new frontmatter block
                    let nextClose = -1;
                    for (let k = bodyEnd + 1; k < lines.length; k++) {
                        if (lines[k].trim() === '---') {
                            nextClose = k;
                            break;
                        }
                    }
                    if (nextClose !== -1) {
                        const candidateFm = lines.slice(bodyEnd + 1, nextClose);
                        if (parseSimpleYaml(candidateFm) !== null) {
                            break; // This is a real frontmatter block
                        }
                    }
                }
                bodyEnd++;
            }

            const bodyText = lines.slice(bodyStart, bodyEnd).join('\n').trim();

            entries.push({
                id: parsed.id || 'unknown_' + Date.now(),
                date: parsed.date || parsed.created || '',
                level: (parsed.level === 'role' ? 'role' : 'project'),
                category: parsed.category || 'uncategorized',
                tags: parseTags(parsed.tags),
                author: parsed.author || 'unknown',
                body: bodyText,
            });

            i = bodyEnd;
        } else {
            unstructuredBuffer.push(lines[i]);
            i++;
        }
    }

    // Flush any trailing unstructured text
    flushUnstructured();

    return entries;
}

/**
 * Parse simple YAML key-value lines (no nesting).
 * Returns null if the content doesn't look like valid frontmatter.
 */
function parseSimpleYaml(lines: string[]): Record<string, string> | null {
    if (lines.length === 0) return null;

    const result: Record<string, string> = {};
    let hasValidKey = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // blank lines OK

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx <= 0) return null; // Not a key-value line

        const key = trimmed.substring(0, colonIdx).trim();
        const value = trimmed.substring(colonIdx + 1).trim();

        // Validate key is a simple identifier
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return null;

        result[key] = value;
        hasValidKey = true;
    }

    return hasValidKey ? result : null;
}

/**
 * Parse tags from a YAML array value like `[tag1, tag2]` or a bare string.
 */
function parseTags(raw: string | undefined): string[] {
    if (!raw) return [];
    const trimmed = raw.trim();

    // Handle bracket-delimited array: [tag1, tag2, tag3]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed
            .slice(1, -1)
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0);
    }

    // Otherwise treat as a single tag
    return trimmed ? [trimmed] : [];
}

// ─── Relevance Scoring ───

/**
 * Score a memory entry for relevance to the current role.
 * - +3 if tags or category match role name (case-insensitive substring)
 * - +2 if dated within last 7 days
 * - +1 if dated within last 30 days
 */
export function scoreEntry(entry: MemoryEntry, currentRole: string): number {
    let score = 0;
    const roleLower = currentRole.toLowerCase();

    // Role match: check tags and category
    if (roleLower) {
        const categoryMatch = entry.category.toLowerCase().includes(roleLower);
        const tagMatch = entry.tags.some(t => t.toLowerCase().includes(roleLower));
        if (categoryMatch || tagMatch) {
            score += 3;
        }
    }

    // Recency scoring
    if (entry.date) {
        try {
            const entryDate = new Date(entry.date);
            const now = new Date();
            const diffMs = now.getTime() - entryDate.getTime();
            const diffDays = diffMs / (1000 * 60 * 60 * 24);

            if (diffDays <= 7) {
                score += 2;
            } else if (diffDays <= 30) {
                score += 1;
            }
        } catch {
            // Invalid date — no recency bonus
        }
    }

    return score;
}

// ─── Tiered Greedy-Fill Loader ───

/**
 * Load and filter memory entries from both project and role files.
 * Uses tiered greedy-fill:
 *   1. Reserve ~2000 chars for top project-level entries
 *   2. Fill ~6000 chars with role-specific entries
 *   3. Fill remainder with all remaining entries
 *
 * Returns body text only (no frontmatter), concatenated with `\n\n`.
 * Never throws — returns empty string on any error.
 */
export function loadFilteredMemory(
    workspacePath: string,
    currentRole: string,
    maxChars: number = 16000
): string {
    try {
        const allEntries: MemoryEntry[] = [];

        // Read project-level memory
        const projectFile = resolveOptimusPath(workspacePath, 'memory', 'continuous-memory.md');
        if (fs.existsSync(projectFile)) {
            try {
                const raw = fs.readFileSync(projectFile, 'utf8');
                allEntries.push(...parseMemoryEntries(raw));
            } catch {
                // Best-effort
            }
        }

        // Read role-level memory
        const sanitizedRole = sanitizeRoleName(currentRole);
        if (sanitizedRole) {
            const roleFile = resolveOptimusPath(workspacePath, 'memory', 'roles', `${sanitizedRole}.md`);
            if (fs.existsSync(roleFile)) {
                try {
                    const raw = fs.readFileSync(roleFile, 'utf8');
                    const roleEntries = parseMemoryEntries(raw);
                    // Mark these as role-level
                    for (const entry of roleEntries) {
                        entry.level = 'role';
                    }
                    allEntries.push(...roleEntries);
                } catch {
                    // Best-effort
                }
            }
        }

        if (allEntries.length === 0) return '';

        // Score all entries
        const scored = allEntries.map(entry => ({
            entry,
            score: scoreEntry(entry, currentRole),
        }));

        // Sort by score desc, then date desc
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            // Date descending (newer first)
            return (b.entry.date || '').localeCompare(a.entry.date || '');
        });

        // Tier budgets
        const projectReserve = Math.min(2000, maxChars);
        const roleBudget = Math.min(6000, maxChars - projectReserve);
        const openBudget = maxChars - projectReserve - roleBudget;

        const selected: string[] = [];
        const used = new Set<number>(); // track indices of selected entries
        let projectUsed = 0;
        let roleUsed = 0;
        let openUsed = 0;

        // Tier 1: Top project-level entries (foundational rules)
        const projectEntries = scored.filter(s => s.entry.level === 'project');
        for (let idx = 0; idx < projectEntries.length; idx++) {
            const body = projectEntries[idx].entry.body;
            if (!body) continue;
            if (projectUsed + body.length + 2 > projectReserve) break;
            selected.push(body);
            projectUsed += body.length + 2;
            used.add(scored.indexOf(projectEntries[idx]));
        }

        // Tier 2: Role-specific entries by score desc, then date desc
        const roleEntries = scored.filter(s => s.entry.level === 'role');
        for (let idx = 0; idx < roleEntries.length; idx++) {
            const body = roleEntries[idx].entry.body;
            if (!body) continue;
            if (roleUsed + body.length + 2 > roleBudget) continue; // try smaller entries
            selected.push(body);
            roleUsed += body.length + 2;
            used.add(scored.indexOf(roleEntries[idx]));
        }

        // Tier 3: All remaining entries by score
        for (let idx = 0; idx < scored.length; idx++) {
            if (used.has(idx)) continue;
            const body = scored[idx].entry.body;
            if (!body) continue;
            if (openUsed + body.length + 2 > openBudget) continue; // try smaller entries
            selected.push(body);
            openUsed += body.length + 2;
        }

        const warning = memoryFreshnessWarning(allEntries);
        const result = selected.join('\n\n').trim();
        return warning ? warning + '\n' + result : result;
    } catch {
        return ''; // Silent fail — memory injection is best-effort
    }
}

// ─── Legacy Migration ───

/**
 * Migrate an existing memory file by wrapping unstructured text
 * in YAML frontmatter blocks.
 *
 * Idempotent: checks for `.migrated` marker file.
 * Atomic: writes to `.tmp` then renames.
 */
export function migrateMemoryFile(filePath: string): void {
    try {
        const markerFile = filePath + '.migrated';
        if (fs.existsSync(markerFile)) return; // Already migrated

        if (!fs.existsSync(filePath)) return; // Nothing to migrate

        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return; // Empty file

        // Parse to see what we have
        const entries = parseMemoryEntries(raw);

        // Check if all entries already have proper frontmatter (no legacy entries)
        const hasLegacy = entries.some(e => e.category === 'legacy');
        if (!hasLegacy) {
            // File is already fully structured — just create the marker
            fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');
            return;
        }

        // Get file mtime for legacy entry dates
        let mtime: string;
        try {
            const stat = fs.statSync(filePath);
            mtime = stat.mtime.toISOString();
        } catch {
            mtime = new Date().toISOString();
        }

        // Re-read and rebuild: structured entries stay as-is, unstructured gets wrapped
        const lines = raw.split('\n');
        const outputParts: string[] = [];
        let i = 0;
        let unstructuredBuffer: string[] = [];

        function flushUnstructuredToOutput(): void {
            const text = unstructuredBuffer.join('\n').trim();
            if (text) {
                const legacyId = 'legacy_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                outputParts.push(
                    '---\n' +
                    `id: ${legacyId}\n` +
                    `date: ${mtime}\n` +
                    'level: project\n' +
                    'category: legacy\n' +
                    'tags: [unstructured, migrated]\n' +
                    'author: system\n' +
                    '---\n' +
                    text
                );
            }
            unstructuredBuffer = [];
        }

        while (i < lines.length) {
            if (lines[i].trim() === '---') {
                const fmStart = i + 1;
                let fmEnd = -1;
                for (let j = fmStart; j < lines.length; j++) {
                    if (lines[j].trim() === '---') {
                        fmEnd = j;
                        break;
                    }
                }

                if (fmEnd !== -1) {
                    const fmLines = lines.slice(fmStart, fmEnd);
                    const parsed = parseSimpleYaml(fmLines);

                    if (parsed !== null) {
                        // Valid frontmatter block — flush unstructured, then copy block as-is
                        flushUnstructuredToOutput();

                        // Find body end
                        let bodyEnd = fmEnd + 1;
                        while (bodyEnd < lines.length) {
                            if (lines[bodyEnd].trim() === '---') {
                                let nextClose = -1;
                                for (let k = bodyEnd + 1; k < lines.length; k++) {
                                    if (lines[k].trim() === '---') {
                                        nextClose = k;
                                        break;
                                    }
                                }
                                if (nextClose !== -1) {
                                    const candidateFm = lines.slice(bodyEnd + 1, nextClose);
                                    if (parseSimpleYaml(candidateFm) !== null) {
                                        break;
                                    }
                                }
                            }
                            bodyEnd++;
                        }

                        // Copy original block verbatim
                        outputParts.push(lines.slice(i, bodyEnd).join('\n'));
                        i = bodyEnd;
                        continue;
                    }
                }

                // Not valid frontmatter — treat as unstructured
                unstructuredBuffer.push(lines[i]);
                i++;
            } else {
                unstructuredBuffer.push(lines[i]);
                i++;
            }
        }

        flushUnstructuredToOutput();

        const output = outputParts.join('\n\n') + '\n';

        // Atomic write: tmp file then rename
        const tmpFile = filePath + '.tmp';
        fs.writeFileSync(tmpFile, output, 'utf8');
        fs.renameSync(tmpFile, filePath);

        // Create migration marker
        fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');
    } catch (e: any) {
        console.error(`[MemoryManager] Migration failed for ${filePath}: ${e.message}`);
        // Non-fatal — memory loading will still work on the unmigrated file
    }
}

// ─── Entry Builder ───

/**
 * Build a formatted memory entry string with YAML frontmatter.
 * Ready to append to a memory file.
 */
export function buildMemoryEntry(params: {
    level: 'project' | 'role';
    category: string;
    tags: string[];
    content: string;
    author: string;
}): string {
    const id = 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const date = new Date().toISOString();
    const tagsStr = params.tags && params.tags.length > 0
        ? '[' + params.tags.join(', ') + ']'
        : '[]';

    return [
        '---',
        `id: ${id}`,
        `date: ${date}`,
        `level: ${params.level}`,
        `category: ${params.category || 'uncategorized'}`,
        `tags: ${tagsStr}`,
        `author: ${params.author}`,
        '---',
        params.content,
        '\n',
    ].join('\n');
}

// ─── File Path Resolution ───

/**
 * Get the memory file path for a given scope.
 * For "role": sanitizes role name, ensures roles dir exists,
 * validates resolved path is under the roles directory.
 */
export function getMemoryFilePath(
    workspacePath: string,
    level: 'project' | 'role',
    role?: string
): string {
    if (level === 'project') {
        return resolveOptimusPath(workspacePath, 'memory', 'continuous-memory.md');
    }

    // level === 'role'
    if (!role) {
        throw new Error('Role name is required for role-level memory');
    }

    // Validate path security before resolution
    validatePathSecurity(role);

    const sanitized = sanitizeRoleName(role);
    if (!sanitized) {
        throw new Error(`Invalid role name after sanitization: '${role}'`);
    }

    const rolesDir = resolveOptimusPath(workspacePath, 'memory', 'roles');

    // Ensure directory exists
    if (!fs.existsSync(rolesDir)) {
        fs.mkdirSync(rolesDir, { recursive: true });
    }

    const targetFile = path.join(rolesDir, `${sanitized}.md`);

    // Security validation: lexical check
    const resolvedTarget = path.resolve(targetFile);
    const resolvedRolesDir = path.resolve(rolesDir);
    const normalizedTarget = normalizeCaseForComparison(resolvedTarget);
    const normalizedPrefix = normalizeCaseForComparison(resolvedRolesDir + path.sep);
    if (!normalizedTarget.startsWith(normalizedPrefix) && normalizedTarget !== normalizeCaseForComparison(resolvedRolesDir)) {
        throw new Error(`Path traversal detected: resolved path '${resolvedTarget}' is outside roles directory`);
    }

    // Security validation: realpathSync on the existing parent directory
    try {
        const realRolesDir = fs.realpathSync(rolesDir);
        if (!resolvedTarget.startsWith(realRolesDir + path.sep)) {
            throw new Error(`Symlink traversal detected: real path of roles dir is '${realRolesDir}'`);
        }
    } catch (e: any) {
        if (e.message && e.message.includes('traversal')) throw e;
        // realpathSync may fail if dir was just created — lexical check is still in place
    }

    return targetFile;
}

// ─── Memory Staleness ───

/**
 * Calculate how many days old a memory entry is.
 * Returns 0 for today, 1 for yesterday, etc.
 */
export function memoryAgeDays(dateStr: string): number {
    try {
        const entryDate = new Date(dateStr);
        if (isNaN(entryDate.getTime())) return -1;
        const now = new Date();
        const diffMs = now.getTime() - entryDate.getTime();
        return Math.floor(diffMs / (24 * 60 * 60 * 1000));
    } catch {
        return -1;
    }
}

/**
 * Generate a staleness warning if the newest memory entry is older than 1 day.
 * Returns empty string if memories are fresh or empty.
 */
export function memoryFreshnessWarning(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';

    // Find the newest entry
    let newestAgeDays = Infinity;
    for (const entry of entries) {
        if (entry.date) {
            const age = memoryAgeDays(entry.date);
            if (age >= 0 && age < newestAgeDays) {
                newestAgeDays = age;
            }
        }
    }

    if (newestAgeDays <= 1) return '';

    return `⚠️ **Memory Staleness Notice** (newest entry: ${newestAgeDays} days ago)\n` +
        `Memories are point-in-time observations, not live state — claims about code behavior ` +
        `or file:line citations may be outdated. Verify against current code before asserting as fact.\n`;
}

// ─── User Memory System ───
// Separate subsystem from project/role memory.
// Different format (plain Markdown bullets), different trust domain,
// different storage location (~/.optimus/memory/user-memory.md).

const ALLOWED_USER_MEMORY_CATEGORIES = ['Preferences', 'Toolchain', 'Lessons', 'Team Conventions', 'Uncategorized'];

const DANGEROUS_PATTERNS: Array<{ name: string; regex: RegExp }> = [
    { name: 'shell-command', regex: /(\$\(|`[^`]+`|exec\(|eval\(|system\(|rm\s+-rf|sudo\s|chmod\s|>\s*\/dev\/null)/ },
    { name: 'pipe-execution', regex: /\|\s*(sh|bash|zsh|node|python|ruby)/ },
    { name: 'secrets', regex: /(password\s*=|api_key\s*=|token\s*=|secret\s*=|aws_[a-z_]+\s*=)/i },
    { name: 'base64-block', regex: /[A-Za-z0-9+\/=]{40,}/ },
    { name: 'prompt-injection', regex: /(ignore previous|ignore all|you are now|system:|<\||\[INST\]|IMPORTANT:\s*override)/i },
    { name: 'file-path', regex: /(\/[a-z_-]+){2,}\.(ts|js|py|rb|go|rs|java|cs)|\\[a-z_-]+\\[a-z_-]+\.(ts|js)/i },
];

/**
 * Get the user memory file path.
 * Overridable via OPTIMUS_USER_MEMORY_PATH env var.
 */
export function getUserMemoryPath(): string {
    return process.env.OPTIMUS_USER_MEMORY_PATH || path.join(os.homedir(), '.optimus', 'memory', 'user-memory.md');
}

/**
 * Validate user memory content against dangerous patterns.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateUserMemoryContent(content: string): { valid: boolean; reason?: string } {
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.regex.test(content)) {
            return { valid: false, reason: `Rejected: content matches '${pattern.name}' safety pattern. User memory should contain generic preferences, not code, secrets, or commands.` };
        }
    }
    return { valid: true };
}

/**
 * Load user memory for prompt injection.
 * Returns empty string if not opted in, in CI, or on any error.
 * Applies sanitizeExternalContent() at read time and strips code blocks.
 * Never throws.
 */
export function loadUserMemory(maxChars: number = 2000): string {
    try {
        // CI guard
        if (process.env.CI === 'true' || process.env.CODESPACES === 'true') return '';

        const memPath = getUserMemoryPath();
        if (!fs.existsSync(memPath)) return '';

        let content = fs.readFileSync(memPath, 'utf8');

        // Apply read-time sanitization
        const { sanitized } = sanitizeExternalContent(content, 'user-memory');
        content = sanitized;

        // Strip fenced code blocks
        content = content.replace(/```[\s\S]*?```/g, '');

        // Truncate to maxChars on a line boundary
        if (content.length > maxChars) {
            const truncated = content.substring(0, maxChars);
            const lastNewline = truncated.lastIndexOf('\n');
            content = lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated;
        }

        return content.trim();
    } catch {
        return '';
    }
}

/**
 * Parse user memory entries from the Markdown bullet list format.
 * Each entry is a `- text` line under a `## Section` header.
 */
export function parseUserMemoryEntries(content: string): Array<{ section: string; text: string; lineNumber: number }> {
    const entries: Array<{ section: string; text: string; lineNumber: number }> = [];
    const lines = content.split('\n');
    let currentSection = 'Uncategorized';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sectionMatch = line.match(/^##\s+(.+)/);
        if (sectionMatch) {
            currentSection = sectionMatch[1].trim();
            continue;
        }
        const entryMatch = line.match(/^-\s+(.+)/);
        if (entryMatch) {
            entries.push({
                section: currentSection,
                text: entryMatch[1].trim(),
                lineNumber: i + 1,
            });
        }
    }

    return entries;
}

/**
 * Resolve category name: capitalize first letter, map unrecognized to Uncategorized.
 */
function resolveCategory(category: string): string {
    const capitalized = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
    // Match against allowed categories (case-insensitive)
    const match = ALLOWED_USER_MEMORY_CATEGORIES.find(c => c.toLowerCase() === category.toLowerCase());
    return match || 'Uncategorized';
}

/**
 * Append an entry to the user memory file under the given category section.
 * Uses atomic temp-file + rename to prevent corruption.
 */
export function appendToUserMemory(category: string, content: string): void {
    const memPath = getUserMemoryPath();
    let fileContent = fs.readFileSync(memPath, 'utf8');
    const resolvedCategory = resolveCategory(category);
    const sectionHeader = `## ${resolvedCategory}`;

    const lines = fileContent.split('\n');
    let sectionIdx = -1;
    let nextSectionIdx = -1;

    // Find the target section (case-insensitive)
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().toLowerCase() === sectionHeader.toLowerCase()) {
            sectionIdx = i;
            // Find next section or EOF
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].match(/^##\s+/)) {
                    nextSectionIdx = j;
                    break;
                }
            }
            break;
        }
    }

    if (sectionIdx === -1) {
        // Section doesn't exist — create it before the last section
        // Find the last ## header
        let lastSectionIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].match(/^##\s+/)) {
                lastSectionIdx = i;
                break;
            }
        }

        if (lastSectionIdx >= 0) {
            // Insert before the last section
            lines.splice(lastSectionIdx, 0, sectionHeader, `- ${content}`, '');
        } else {
            // No sections at all — append at end
            lines.push('', sectionHeader, `- ${content}`, '');
        }
    } else {
        // Section exists — append entry at end of section
        const insertIdx = nextSectionIdx !== -1 ? nextSectionIdx : lines.length;
        // Insert before the next section (or at EOF), ensuring a blank line before next section
        lines.splice(insertIdx, 0, `- ${content}`);
    }

    const newContent = lines.join('\n');

    // Update header metadata
    const updatedContent = updateUserMemoryHeader(newContent);

    // Atomic write
    const tmpPath = memPath + '.tmp';
    fs.writeFileSync(tmpPath, updatedContent, 'utf8');
    fs.renameSync(tmpPath, memPath);
}

/**
 * Remove a user memory entry by 1-indexed number.
 * Uses atomic temp-file + rename.
 */
export function removeUserMemoryEntry(index: number): void {
    const memPath = getUserMemoryPath();
    const fileContent = fs.readFileSync(memPath, 'utf8');
    const entries = parseUserMemoryEntries(fileContent);

    if (index < 1 || index > entries.length) {
        throw new Error(`Invalid entry number ${index}. Valid range: 1-${entries.length}`);
    }

    const targetEntry = entries[index - 1];
    const lines = fileContent.split('\n');

    // Remove the line at the target lineNumber (1-indexed)
    lines.splice(targetEntry.lineNumber - 1, 1);

    const newContent = lines.join('\n');
    const updatedContent = updateUserMemoryHeader(newContent);

    // Atomic write
    const tmpPath = memPath + '.tmp';
    fs.writeFileSync(tmpPath, updatedContent, 'utf8');
    fs.renameSync(tmpPath, memPath);
}

/**
 * Update the # Last updated and # Entries header lines in user memory content.
 */
function updateUserMemoryHeader(content: string): string {
    const lines = content.split('\n');
    const entryCount = parseUserMemoryEntries(content).length;

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        if (lines[i].startsWith('# Last updated:')) {
            lines[i] = `# Last updated: ${new Date().toISOString()}`;
        }
        if (lines[i].startsWith('# Entries:')) {
            lines[i] = `# Entries: ${entryCount}`;
        }
    }

    return lines.join('\n');
}

// ─── Memory Snapshot Initialization ───

/**
 * Check if a memory snapshot exists and whether local memory needs initialization.
 *
 * @returns 'none' if no snapshot exists, 'initialize' if snapshot exists but local
 *          memory hasn't been initialized from it, 'synced' if already synced.
 */
export function checkMemorySnapshot(workspacePath: string): 'none' | 'initialize' | 'synced' {
    const snapshotDir = path.join(workspacePath, '.optimus', 'memory', 'snapshots');
    const syncMarker = path.join(workspacePath, '.optimus', 'memory', '.snapshot-synced.json');

    // Check if snapshot directory exists and has content
    if (!fs.existsSync(snapshotDir)) return 'none';

    let snapshotFiles: string[];
    try {
        snapshotFiles = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.md'));
    } catch {
        return 'none';
    }
    if (snapshotFiles.length === 0) return 'none';

    // Check snapshot metadata
    const snapshotMetaPath = path.join(snapshotDir, 'snapshot.json');
    let snapshotUpdatedAt = 0;
    try {
        if (fs.existsSync(snapshotMetaPath)) {
            const meta = JSON.parse(fs.readFileSync(snapshotMetaPath, 'utf8'));
            snapshotUpdatedAt = meta.updatedAt || 0;
        }
    } catch { /* ignore */ }

    // Check sync marker
    if (fs.existsSync(syncMarker)) {
        try {
            const synced = JSON.parse(fs.readFileSync(syncMarker, 'utf8'));
            // Already synced and snapshot hasn't been updated since
            if (synced.syncedAt && (!snapshotUpdatedAt || synced.syncedAt >= snapshotUpdatedAt)) {
                return 'synced';
            }
        } catch { /* corrupted marker, re-initialize */ }
    }

    return 'initialize';
}

/**
 * Initialize local memory from snapshot files.
 * Copies snapshot .md files into the project memory directory.
 * Creates a sync marker to prevent re-initialization.
 */
export function initializeFromSnapshot(workspacePath: string): { copied: number; skipped: number } {
    const snapshotDir = path.join(workspacePath, '.optimus', 'memory', 'snapshots');
    const memoryDir = path.join(workspacePath, '.optimus', 'memory');
    const syncMarker = path.join(memoryDir, '.snapshot-synced.json');

    let copied = 0;
    let skipped = 0;

    try {
        const files = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.md'));

        for (const file of files) {
            const srcPath = path.join(snapshotDir, file);
            const destPath = path.join(memoryDir, file);

            // Don't overwrite existing memory files
            if (fs.existsSync(destPath)) {
                skipped++;
                continue;
            }

            fs.copyFileSync(srcPath, destPath);
            copied++;
        }

        // Also copy role-specific snapshots if they exist
        const rolesSnapshotDir = path.join(snapshotDir, 'roles');
        if (fs.existsSync(rolesSnapshotDir)) {
            const rolesDir = path.join(memoryDir, 'roles');
            fs.mkdirSync(rolesDir, { recursive: true });

            const roleFiles = fs.readdirSync(rolesSnapshotDir).filter(f => f.endsWith('.md'));
            for (const file of roleFiles) {
                const srcPath = path.join(rolesSnapshotDir, file);
                const destPath = path.join(rolesDir, file);

                if (fs.existsSync(destPath)) {
                    skipped++;
                    continue;
                }

                fs.copyFileSync(srcPath, destPath);
                copied++;
            }
        }

        // Write sync marker
        fs.writeFileSync(syncMarker, JSON.stringify({
            syncedAt: Date.now(),
            copiedFiles: copied,
            skippedFiles: skipped,
        }, null, 2), 'utf8');

    } catch (err) {
        console.error(`[Memory] Snapshot initialization failed: ${err instanceof Error ? err.message : err}`);
    }

    return { copied, skipped };
}
