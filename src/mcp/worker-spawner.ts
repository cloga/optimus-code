/**
 * Error Message Contract
 *
 * All errors thrown or logged from this module MUST follow this format:
 *   [Category] What failed: <details>. Suggested fix: <action>.
 *
 * Categories:
 *   [Spawner]        — Worker process lifecycle (spawn, heartbeat, reap)
 *   [Engine]         — Engine/model resolution and adapter instantiation
 *   [T2 Guard]       — T2 role template quality gate
 *   [Precipitation]  — T3→T2 or T2→T1 tier promotion
 *   [Config]         — Config file read/parse/validation
 *   [Orchestrator]   — Top-level delegation or council dispatch
 *
 * All catch blocks MUST log via console.error() — no silent swallowing.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { AgentAdapter } from "../adapters/AgentAdapter";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";
import { MAX_DELEGATION_DEPTH } from "../constants";
import { sanitizeExternalContent } from "../utils/sanitizeExternalContent";

function parseFrontmatter(content: string): { frontmatter: Record<string, string>, body: string } {
    const normalized = content.replace(/\r\n/g, '\n');
    const yamlRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = normalized.match(yamlRegex);
    let frontmatter: Record<string, string> = {};
    let body = normalized;
    
    if (match) {
        const yamlBlock = match[1];
        body = match[2];
        yamlBlock.split('\n').forEach(line => {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim();
                const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
                if (key) frontmatter[key] = value;
            }
        });
    }
    
    return { frontmatter, body };
}

export function updateFrontmatter(content: string, updates: Record<string, string>): string {
    const parsed = parseFrontmatter(content);
    const newFm = { ...parsed.frontmatter, ...updates };
    
    let yamlStr = '---\n';
    for (const [k, v] of Object.entries(newFm)) {
        yamlStr += `${k}: ${v}\n`;
    }
    yamlStr += '---';
    
    const bodyStr = parsed.body.startsWith('\n') ? parsed.body : '\n' + parsed.body;
    return yamlStr + bodyStr;
}

// ─── Role Name Sanitization (prevents path traversal) ───

function sanitizeRoleName(role: string): string {
    return role.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100);
}

// ─── T3 Usage Tracking & Precipitation ───

// File-level mutex to prevent concurrent read-modify-write on t3-usage-log.json
let t3LogMutex: Promise<void> = Promise.resolve();

interface T3UsageEntry {
    role: string;
    invocations: number;
    successes: number;
    failures: number;
    consecutive_failures: number;
    lastUsed: string;
    engine: string;
    model?: string;
}

function getT3UsageLogPath(workspacePath: string): string {
    return path.join(workspacePath, '.optimus', 'state', 't3-usage-log.json');
}

export function loadT3UsageLog(workspacePath: string): Record<string, T3UsageEntry> {
    const logPath = getT3UsageLogPath(workspacePath);
    try {
        if (fs.existsSync(logPath)) {
            return JSON.parse(fs.readFileSync(logPath, 'utf8'));
        }
    } catch (e: any) { console.error(`[T3UsageLog] Warning: failed to read usage log: ${e.message}`); }
    return {};
}

export function saveT3UsageLog(workspacePath: string, log: Record<string, T3UsageEntry>): void {
    const logPath = getT3UsageLogPath(workspacePath);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
}

function trackT3Usage(workspacePath: string, role: string, success: boolean, engine: string, model?: string): void {
    // Serialize access via mutex to prevent concurrent overwrites
    t3LogMutex = t3LogMutex.then(() => {
        const log = loadT3UsageLog(workspacePath);
        if (!log[role]) {
            log[role] = { role, invocations: 0, successes: 0, failures: 0, consecutive_failures: 0, lastUsed: '', engine, model };
        }
        if (log[role].consecutive_failures === undefined) {
            log[role].consecutive_failures = 0;
        }
        log[role].invocations++;
        if (success) {
            log[role].successes++;
            log[role].consecutive_failures = 0;
        } else {
            log[role].failures++;
            log[role].consecutive_failures++;
        }
        log[role].lastUsed = new Date().toISOString();
        log[role].engine = engine;
        if (model) log[role].model = model;
        saveT3UsageLog(workspacePath, log);
    }).catch(() => {});
}

/**
 * Role info provided by Master Agent at delegation time.
 * Master has the most context — it decides what the role is, which engine to use, etc.
 */
export interface MasterRoleInfo {
    description?: string;  // What this role does
    engine?: string;       // Which engine (e.g. 'claude-code', 'copilot-cli')
    model?: string;        // Which model (e.g. 'claude-opus-4.6-1m')
    requiredSkills?: string[]; // Skills this role needs before task execution
    mode?: 'agent' | 'plan'; // Execution mode: 'agent' = full access, 'plan' = read-only + MCP tools only
}

/**
 * Pre-flight: Check if all required skills exist. Returns missing skill names.
 * Skills live at .optimus/skills/<name>/SKILL.md
 */
function checkRequiredSkills(workspacePath: string, skills: string[]): { found: Map<string, string>, missing: string[] } {
    // Backward compat: agent-creator was renamed to role-creator in Issue #213
    const SKILL_ALIASES: Record<string, string> = { 'agent-creator': 'role-creator' };
    const found = new Map<string, string>();
    const missing: string[] = [];
    for (const skill of skills) {
        const resolvedSkill = SKILL_ALIASES[skill] || skill;
        const skillPath = path.join(workspacePath, '.optimus', 'skills', resolvedSkill, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
            found.set(skill, fs.readFileSync(skillPath, 'utf8'));
        } else {
            missing.push(skill);
        }
    }
    return { found, missing };
}

// ─── Engine/Model Validation (prevents corrupted T2 templates) ───

export function loadValidEnginesAndModels(workspacePath: string): { engines: string[]; models: Record<string, string[]> } {
    const configPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const engines = Object.keys(config.engines || {});
            const models: Record<string, string[]> = {};
            for (const eng of engines) {
                models[eng] = config.engines[eng]?.available_models || [];
            }
            return { engines, models };
        }
    } catch (e: any) { console.error(`[EngineValidation] Warning: failed to read available-agents.json: ${e.message}`); }
    return { engines: [], models: {} };
}

export function isValidEngine(engine: string, validEngines: string[]): boolean {
    return validEngines.length === 0 || validEngines.includes(engine);
}

export function isValidModel(model: string, engine: string, validModels: Record<string, string[]>): boolean {
    const allowed = validModels[engine];
    if (!allowed || allowed.length === 0) return true; // no config = permissive
    return allowed.includes(model);
}

/**
 * Ensure a T2 role template exists. Creates if new, updates if Master provides new info.
 * T1 instances are NEVER retroactively modified — they are frozen snapshots.
 */
async function ensureT2Role(workspacePath: string, role: string, engine: string, model?: string, masterInfo?: MasterRoleInfo, delegationDepth?: number): Promise<string | null> {
    const safeRole = sanitizeRoleName(role);
    const t2Dir = path.join(workspacePath, '.optimus', 'roles');
    const t2Path = path.join(t2Dir, `${safeRole}.md`);

    if (!fs.existsSync(t2Dir)) fs.mkdirSync(t2Dir, { recursive: true });

    const formattedRole = safeRole
        .split(/[-_]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    const rawDesc = masterInfo?.description || `${formattedRole} expert`;
    // Unescape literal \n sequences from JSON/MCP transport into real newlines
    const desc = rawDesc.replace(/\\n/g, '\n');
    const eng = masterInfo?.engine || engine;
    const mod = masterInfo?.model || model || '';

    if (fs.existsSync(t2Path)) {
        const existing = fs.readFileSync(t2Path, 'utf8');
        const existingFm = parseFrontmatter(existing);

        // Quality gate: check if existing T2 is thin (< 25 content lines)
        const contentLines = existingFm.body.split('\n').filter(l => l.trim().length > 0);
        const isThin = contentLines.length < 25 && existingFm.frontmatter.source !== 'plugin';

        if (isThin) {
            console.error(`[Precipitation] Thin T2 template detected for '${safeRole}' (${contentLines.length} lines). Attempting regeneration...`);
            // Fall through — do NOT early-return. Will attempt rich regeneration below.
        } else {
            // Rich template — update metadata if Master provided new info, then return
            if (masterInfo?.description || masterInfo?.engine || masterInfo?.model) {
                const updates: Record<string, string> = {};
                if (masterInfo.description) updates.description = `"${masterInfo.description.substring(0, 200).replace(/"/g, "'")}"`;
                const { engines: validEngines, models: validModels } = loadValidEnginesAndModels(workspacePath);
                if (masterInfo.engine) {
                    if (isValidEngine(masterInfo.engine, validEngines)) {
                        updates.engine = masterInfo.engine;
                    } else {
                        console.error(`[T2 Guard] Rejected invalid engine '${masterInfo.engine}' for role '${safeRole}'. Valid: ${validEngines.join(', ')}`);
                    }
                }
                if (masterInfo.model) {
                    const resolvedEng = updates.engine || existingFm.frontmatter.engine || engine;
                    if (isValidModel(masterInfo.model, resolvedEng, validModels)) {
                        updates.model = masterInfo.model;
                    } else {
                        console.error(`[T2 Guard] Rejected invalid model '${masterInfo.model}' for engine '${resolvedEng}' on role '${safeRole}'. Valid: ${(validModels[resolvedEng] || []).join(', ')}`);
                    }
                }
                updates.updated_at = new Date().toISOString();
                const updated = updateFrontmatter(existing, updates);
                fs.writeFileSync(t2Path, updated, 'utf8');
                console.error(`[T2 Evolution] Updated role '${safeRole}' template with new Master info`);
            }
            return null; // Rich template — not a new creation
        }
    }

    // T2 does not exist — check for pre-installed plugin role template first
    // Plugin roles ship in optimus-plugin/roles/ and provide rich persona definitions.
    // This avoids generating thin one-liner T2s for well-known roles like architect, pm, qa-engineer.
    const pluginRolePaths = [
        path.join(__dirname, '..', '..', 'roles', `${safeRole}.md`),         // from dist/
        path.join(__dirname, '..', '..', '..', 'optimus-plugin', 'roles', `${safeRole}.md`), // from src/mcp/
    ];
    for (const pluginPath of pluginRolePaths) {
        try {
            if (fs.existsSync(pluginPath)) {
                const pluginContent = fs.readFileSync(pluginPath, 'utf8');
                // Update engine/model from Master info before writing
                let finalContent = pluginContent;
                const updates: Record<string, string> = {};
                const { engines: validEnginesPlugin, models: validModelsPlugin } = loadValidEnginesAndModels(workspacePath);
                if (eng) {
                    if (isValidEngine(eng, validEnginesPlugin)) {
                        updates.engine = eng;
                    } else {
                        console.error(`[T2 Guard] Rejected invalid engine '${eng}' for role '${safeRole}'. Valid: ${validEnginesPlugin.join(', ')}`);
                    }
                }
                if (mod) {
                    const resolvedEngPlugin = updates.engine || eng;
                    if (updates.engine && isValidModel(mod, resolvedEngPlugin, validModelsPlugin)) {
                        updates.model = mod;
                    } else if (!updates.engine) {
                        // Engine was rejected — discard model too
                        console.error(`[T2 Guard] Discarding model '${mod}' — engine was invalid for role '${safeRole}'`);
                    } else {
                        console.error(`[T2 Guard] Rejected invalid model '${mod}' for engine '${resolvedEngPlugin}' on role '${safeRole}'. Valid: ${(validModelsPlugin[resolvedEngPlugin] || []).join(', ')}`);
                    }
                }
                updates.precipitated = new Date().toISOString();
                if (Object.keys(updates).length > 0) {
                    finalContent = updateFrontmatter(pluginContent, updates);
                }
                fs.writeFileSync(t2Path, finalContent, 'utf8');
                console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 from plugin template at ${t2Path}`);
                return t2Path;
            }
        } catch (e: any) { console.error(`[Precipitation] Warning: failed to process plugin template: ${e.message}`); }
    }

    // No plugin template found — check if Master provided a meaningful description
    const hasExplicitDescription = !!masterInfo?.description && masterInfo.description.trim().length > 0;

    if (!hasExplicitDescription) {
        // Master didn't provide role_description — refuse to create garbage T2.
        // The role will operate as T3 (zero-shot) this time without polluting the filesystem.
        console.error(
            `[T2 Guard] Refused to create T2 for '${safeRole}': no role_description provided by Master. ` +
            `Role will run as T3 zero-shot. To create a proper T2, the delegating agent should either: ` +
            `(1) provide a detailed role_description in delegate_task, or ` +
            `(2) use role-creator to pre-create the role before delegation.`
        );
        return null; // No T2 created — agent proceeds as T3
    }

    // No plugin template found — use role-creator for rich T2 generation
    const META_ROLES = ['role-creator', 'skill-creator', 'agent-creator']; // agent-creator kept as alias for backward compat
    const safeRoleCheck = sanitizeRoleName(role);
    const currentDepthLocal = delegationDepth ?? 0;

    // Validate eng/mod before embedding in any template literal
    const { engines: validEnginesFallback, models: validModelsFallback } = loadValidEnginesAndModels(workspacePath);
    let validatedEng = eng;
    let validatedMod = mod;
    if (eng && !isValidEngine(eng, validEnginesFallback)) {
        console.error(`[T2 Guard] Rejected invalid engine '${eng}' for role '${safeRole}'. Valid: ${validEnginesFallback.join(', ')}`);
        validatedEng = validEnginesFallback[0] || '';
        validatedMod = ''; // engine invalid → discard model
    } else if (mod && !isValidModel(mod, eng, validModelsFallback)) {
        console.error(`[T2 Guard] Rejected invalid model '${mod}' for engine '${eng}' on role '${safeRole}'. Valid: ${(validModelsFallback[eng] || []).join(', ')}`);
        validatedMod = '';
    }

    if (META_ROLES.includes(safeRoleCheck) || currentDepthLocal >= MAX_DELEGATION_DEPTH - 1) {
        // Bootstrap paradox or depth budget exhausted — fall back to thin template
        console.error(`[Precipitation] Falling back to thin template for '${safeRole}' (meta-role: ${META_ROLES.includes(safeRoleCheck)}, depth: ${currentDepthLocal}/${MAX_DELEGATION_DEPTH})`);
        const template = `---
role: ${safeRole}
tier: T2
thin: true
description: "${desc.substring(0, 200).replace(/"/g, "'")}"
engine: ${validatedEng}
model: ${validatedMod}
precipitated: ${new Date().toISOString()}
---

# ${formattedRole}

${desc}
`;
        fs.writeFileSync(t2Path, template, 'utf8');
        console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 (thin) at ${t2Path}`);
        return t2Path;
    }

    // Normal path: use role-creator for rich role generation
    try {
        await generateRichT2Role(workspacePath, role, validatedEng, validatedMod || undefined, desc, t2Path, currentDepthLocal);
        console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 (rich, via role-creator) at ${t2Path}`);
        return t2Path;
    } catch (err: any) {
        // Do NOT write a thin fallback — let the role remain T3 and retry next invocation
        console.error(`[Precipitation] role-creator failed for '${safeRole}': ${err.message}. Role will remain T3 (zero-shot). To fix: (1) check role-creator skill at .optimus/skills/role-creator/SKILL.md, (2) ensure engine CLI is authenticated, (3) retry delegation with explicit role_description.`);
        return null;
    }
}

/**
 * Synchronously invoke role-creator to produce a rich T2 role definition.
 * Used by ensureT2Role() when no plugin template exists and anti-recursion guards pass.
 */
async function generateRichT2Role(
    workspacePath: string,
    role: string,
    engine: string,
    model: string | undefined,
    description: string,
    t2Path: string,
    delegationDepth: number
): Promise<void> {
    const safeRole = sanitizeRoleName(role);

    // 1. Read the role-creator skill (optional — degrade gracefully if missing)
    const skillPath = path.join(workspacePath, '.optimus', 'skills', 'role-creator', 'SKILL.md');
    let roleCreatorSkillContent = '';
    if (fs.existsSync(skillPath)) {
        roleCreatorSkillContent = fs.readFileSync(skillPath, 'utf8');
    }

    const formattedRole = safeRole
        .split(/[-_]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    // 2. Construct the prompt
    const prompt = `You are a role-creation specialist. Your task is to create a professional-grade T2 role template.

Role name: ${safeRole}
Role display name: ${formattedRole}
Role description: ${description}
Engine: ${engine}
Model: ${model || 'default'}

Using the role-creator skill guidance below, produce a COMPLETE role definition file.

The output MUST be a valid markdown file with YAML frontmatter. Output ONLY the file content — no explanations, no code fences around it.

Required frontmatter fields:
---
role: ${safeRole}
tier: T2
description: "<rich 1-2 sentence description>"
engine: ${engine}
model: ${model || ''}
precipitated: ${new Date().toISOString()}
auto_created: true
---

Required body sections:
# ${formattedRole}
<2-3 sentence purpose statement>
## Core Responsibilities
- <3-5 specific actionable responsibilities>
## Quality Standards
- <2-3 measurable quality criteria>
## Constraints
- <2-3 behavioral boundaries>

${roleCreatorSkillContent ? `=== SKILL REFERENCE ===\n${roleCreatorSkillContent}\n=== END SKILL REFERENCE ===` : ''}`;

    // 3. Get adapter and invoke
    const adapter = getAdapterForEngine(engine, undefined, model);
    const childDepth = delegationDepth + 1;
    const extraEnv: Record<string, string> = {
        OPTIMUS_DELEGATION_DEPTH: String(childDepth)
    };
    const response = await adapter.invoke(prompt, 'agent', undefined, undefined, extraEnv);

    // 4. Parse the response — look for frontmatter start
    const fmStart = response.indexOf('---');
    if (fmStart === -1) {
        throw new Error('role-creator response did not contain valid frontmatter (no --- found)');
    }
    const content = response.slice(fmStart).trim();

    // Validate that we have a closing frontmatter delimiter
    const secondDash = content.indexOf('---', 3);
    if (secondDash === -1) {
        throw new Error('role-creator response had opening --- but no closing frontmatter delimiter');
    }

    // 5. Write the rich role to t2Path
    const dir = path.dirname(t2Path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(t2Path, content, 'utf8');
}

export class AgentLockManager {
    private locks = new Map<string, Promise<void>>();
    private resolvers = new Map<string, () => void>();
    private workspacePath: string;

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
    }

    private get lockDir(): string {
        return path.join(this.workspacePath, '.optimus', 'agents');
    }

    private lockFilePath(role: string): string {
        return path.join(this.lockDir, `${role}.lock`);
    }

    async acquireLock(role: string): Promise<void> {
        while (this.locks.has(role)) {
            await this.locks.get(role);
        }
        let resolve: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        this.locks.set(role, promise);
        this.resolvers.set(role, resolve!);
        this.writeLockFile(role);
    }

    releaseLock(role: string): void {
        const resolve = this.resolvers.get(role);
        this.locks.delete(role);
        this.resolvers.delete(role);
        this.deleteLockFile(role);
        if (resolve) resolve();
    }

    private writeLockFile(role: string): void {
        try {
            if (!fs.existsSync(this.lockDir)) {
                fs.mkdirSync(this.lockDir, { recursive: true });
            }
            fs.writeFileSync(this.lockFilePath(role), JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf8');
        } catch (e: any) {
            console.error(`[AgentLockManager] Warning: failed to write lock file for '${role}': ${e.message}. In-memory lock still active.`);
        }
    }

    private deleteLockFile(role: string): void {
        try {
            fs.unlinkSync(this.lockFilePath(role));
        } catch (e: any) {
            if (e.code !== 'ENOENT') console.error(`[AgentLockManager] Warning: failed to delete lock file for '${role}': ${e.message}`);
        }
    }

    cleanStaleLocks(): void {
        try {
            if (!fs.existsSync(this.lockDir)) return;
            const files = fs.readdirSync(this.lockDir);
            for (const file of files) {
                if (!file.endsWith('.lock')) continue;
                const filePath = path.join(this.lockDir, file);
                try {
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    if (content.pid && !isProcessRunning(content.pid)) {
                        fs.unlinkSync(filePath);
                        console.error(`[AgentLockManager] Cleaned stale lock for ${file} (PID ${content.pid} no longer running)`);
                    }
                } catch (e: any) {
                    console.error(`[AgentLockManager] Removing malformed lock file ${file}: ${e.message}`);
                    try { fs.unlinkSync(filePath); } catch (e2: any) { console.error(`[AgentLockManager] Warning: cleanup failed for ${file}: ${e2.message}`); }
                }
            }
        } catch (e: any) {
            console.error(`[AgentLockManager] Warning: stale lock cleanup failed: ${e.message}`);
        }
    }
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// Module-level singleton; initialized lazily per workspace
let lockManagerInstance: AgentLockManager | null = null;
function getLockManager(workspacePath: string): AgentLockManager {
    if (!lockManagerInstance) {
        lockManagerInstance = new AgentLockManager(workspacePath);
        lockManagerInstance.cleanStaleLocks();
    }
    return lockManagerInstance;
}

export class ConcurrencyGovernor {
    private static maxConcurrentWorkers = 3;
    private static activeWorkers = 0;
    private static queue: (() => void)[] = [];

    public static async acquire(): Promise<void> {
        if (this.activeWorkers < this.maxConcurrentWorkers) {
            this.activeWorkers++;
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.queue.push(resolve);
        });
    }

    public static release(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) next();
        } else {
            this.activeWorkers--;
        }
    }
}

function parseRoleSpec(roleArg: string): { role: string, engine?: string, model?: string } {
    const segments = path.basename(roleArg).split('_').filter(Boolean);
    const engineIndex = segments.findIndex(segment => segment === 'claude-code' || segment === 'copilot-cli' || segment === 'github-copilot');

    if (engineIndex === -1) {
        return { role: path.basename(roleArg) };
    }

    const role = segments.slice(0, engineIndex).join('_') || path.basename(roleArg);
    const engine = segments[engineIndex];
    const model = segments.slice(engineIndex + 1).join('_');
    return { role, engine, model };
}

function getAdapterForEngine(engine: string, sessionId?: string, model?: string): AgentAdapter {
    if (engine === 'copilot-cli' || engine === 'github-copilot') {
        return new GitHubCopilotAdapter(undefined, '🛸 GitHub Copilot', model || '');
    }
    return new ClaudeCodeAdapter(undefined, '🦖 Claude Code', model || '');
}

/**
 * Loads project memory entries from .optimus/memory/continuous-memory.md.
 * Returns newest-first entries (body only, frontmatter stripped) up to maxChars.
 * Best-effort: returns empty string on any error.
 */
function loadProjectMemory(workspacePath: string, maxChars: number = 4000): string {
    const memoryFile = path.join(workspacePath, '.optimus', 'memory', 'continuous-memory.md');
    if (!fs.existsSync(memoryFile)) return '';

    try {
        const raw = fs.readFileSync(memoryFile, 'utf8');
        if (!raw.trim()) return '';

        // Split on YAML frontmatter delimiters to get individual entries
        // Each entry starts with ---\nid: ... \n---\n<body>
        const entries = raw.split(/(?=^---\nid:)/m).filter(e => e.trim());

        // Reverse for newest-first
        entries.reverse();

        let content = '';
        for (const entry of entries) {
            // Strip YAML frontmatter, keep only body text
            const body = entry.replace(/^---[\s\S]*?---\n?/m, '').trim();
            if (!body) continue;
            if (content.length + body.length + 4 > maxChars) break;
            content = body + '\n\n' + content; // Prepend to restore chronological order
        }

        return content.trim();
    } catch (e) {
        return ''; // Silent fail — memory injection is best-effort
    }
}

/**
 * Executes a single task delegation synchronously.
 */
export async function delegateTaskSingle(roleArg: string, taskPath: string, outputPath: string, _fallbackSessionId: string, workspacePath: string, contextFiles?: string[], masterInfo?: MasterRoleInfo, parentDepth?: number, parentIssueNumber?: number, autoIssueNumber?: number): Promise<string> {
    const parsedRole = parseRoleSpec(roleArg);
    const role = sanitizeRoleName(parsedRole.role);

    const currentDepth = parentDepth !== undefined ? parentDepth : parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || '0', 10);
    const childDepth = currentDepth + 1;
    console.error(`[Orchestrator] Delegation depth: ${childDepth}/${MAX_DELEGATION_DEPTH}`);
    if (childDepth >= MAX_DELEGATION_DEPTH) {
        console.error(`[Orchestrator] Max delegation depth reached — MCP config will be stripped`);
    }

    // Auto-migrate legacy folder `.optimus/personas` to `.optimus/agents`
    const legacyT1Dir = path.join(workspacePath, '.optimus', 'personas');
    const t1Dir = path.join(workspacePath, '.optimus', 'agents');
    if (fs.existsSync(legacyT1Dir) && !fs.existsSync(t1Dir)) {
        try { fs.renameSync(legacyT1Dir, t1Dir); } catch (e: any) { console.error(`[Orchestrator] Warning: operation failed: ${e.message}`); }
    }
    
    const t2Dir = path.join(workspacePath, '.optimus', 'roles');
    if (!fs.existsSync(t2Dir)) {
        fs.mkdirSync(t2Dir, { recursive: true });
    }
    // T2 roles are created ONLY via T3 precipitation or manual user creation.
    // No lazy-sync from plugin built-in roles.

    const t2Path = path.join(t2Dir, `${role}.md`);

    // Resolve engine/model/mode priority: Master info > role spec > available-agents.json > fallback
    let activeEngine = masterInfo?.engine || parsedRole.engine;
    let activeModel = masterInfo?.model || parsedRole.model;
    let activeMode: 'agent' | 'plan' = masterInfo?.mode || 'agent';
    let activeSessionId: string | undefined = undefined;

    let t1Content = '';
    let t1Path = '';  // Will be resolved dynamically based on role+engine match
    let shouldLocalize = false;
    let resolvedTier = 'T3 (Zero-Shot Outsource)';
    let personaProof = 'No dedicated role template found in T2 or T1. Using T3 generic prompt.';

    // --- T1 Lookup: glob agents/{role}_*.md, find matching engine ---
    if (fs.existsSync(t1Dir)) {
        const t1Candidates = fs.readdirSync(t1Dir)
            .filter(f => f.startsWith(`${role}_`) && f.endsWith('.md'));
        for (const candidate of t1Candidates) {
            const candidatePath = path.join(t1Dir, candidate);
            const candidateFm = parseFrontmatter(fs.readFileSync(candidatePath, 'utf8'));
            // Match by engine: if caller specified an engine, only match that; otherwise match any
            if (!activeEngine || candidateFm.frontmatter.engine === activeEngine) {
                t1Path = candidatePath;
                t1Content = fs.readFileSync(candidatePath, 'utf8');
                resolvedTier = `T1 (Agent Instance -> ${candidate})`;
                personaProof = `Found local project agent state: ${t1Path}`;
                break;
            }
        }
    }

    if (!t1Content && fs.existsSync(t2Path)) {
        t1Content = fs.readFileSync(t2Path, 'utf8');
        shouldLocalize = true;
        resolvedTier = `T2 (Role Template -> ${role}.md)`;
        personaProof = `Found globally promoted Role template: ${t2Path}`;
    }

    if (t1Content) {
        const fm = parseFrontmatter(t1Content);
        // Frontmatter values are defaults; caller-supplied masterInfo takes priority
        if (fm.frontmatter.engine && !activeEngine) activeEngine = fm.frontmatter.engine;
        if (fm.frontmatter.session_id) activeSessionId = fm.frontmatter.session_id;
        if (fm.frontmatter.model && !activeModel) activeModel = fm.frontmatter.model;
        // Mode from T2 frontmatter: 'plan' = read-only orchestrator, 'agent' = full access
        if (fm.frontmatter.mode && !masterInfo?.mode) activeMode = fm.frontmatter.mode as 'agent' | 'plan';
    }

    // --- Pre-Flight: Quarantine check ---
    if (t1Content) {
        const qfm = parseFrontmatter(t1Content);
        if (qfm.frontmatter.status === 'quarantined') {
            const usageLog = loadT3UsageLog(workspacePath);
            const usageEntry = usageLog[role];
            throw new Error(
                `⚠️ **Role Quarantined**: Role '${role}' is quarantined due to ${usageEntry?.consecutive_failures || '3+'} consecutive failures ` +
                `(quarantined at: ${qfm.frontmatter.quarantined_at || 'unknown'}). ` +
                `**Recovery**: (1) Fix the role template at '.optimus/roles/${role}.md', or (2) delete it to allow T3 re-creation, or (3) use the quarantine_role tool to unquarantine it.`
            );
        }
    }
    // Also check the T2 directly (T1 might have been created before quarantine)
    if (fs.existsSync(t2Path)) {
        const t2Fm = parseFrontmatter(fs.readFileSync(t2Path, 'utf8'));
        if (t2Fm.frontmatter.status === 'quarantined') {
            const usageLog2 = loadT3UsageLog(workspacePath);
            const usageEntry2 = usageLog2[role];
            throw new Error(
                `⚠️ **Role Quarantined**: Role '${role}' is quarantined due to ${usageEntry2?.consecutive_failures || '3+'} consecutive failures ` +
                `(quarantined at: ${t2Fm.frontmatter.quarantined_at || 'unknown'}). ` +
                `**Recovery**: (1) Fix the role template at '.optimus/roles/${role}.md', or (2) delete it to allow T3 re-creation, or (3) use the quarantine_role tool to unquarantine it.`
            );
        }
    }

    // Fallback: if engine/model still unset, try reading available-agents.json
    if (!activeEngine) {
        const configPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
        try {
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                const engines = Object.keys(config.engines || {}).filter(
                    e => !config.engines[e].status?.includes('demo')
                );
                if (engines.length > 0) {
                    // Prefer claude-code if available, else first engine
                    activeEngine = engines.includes('claude-code') ? 'claude-code' : engines[0];
                    if (!activeModel) {
                        const models = config.engines[activeEngine]?.available_models;
                        if (Array.isArray(models) && models.length > 0) {
                            activeModel = models[0];
                        }
                    }
                }
            }
        } catch (e: any) { console.error(`[Orchestrator] Warning: operation failed: ${e.message}`); }
    }

    if (!activeEngine) {
        throw new Error(
            `⚠️ **Engine Resolution Failed**: Unable to resolve a viable engine (e.g., 'github-copilot', 'claude-code') for role \`${role}\`.\n` +
            `No engine was specified in the caller arguments, local frontmatter, or T2 metadata. ` +
            `Please explicitly specify an engine or create the role with proper configurations first.`
        );
    }

    // --- Model Pre-Flight Validation ---
    // If a model was explicitly provided, validate it against available-agents.json whitelist.
    // Prevents invalid model names from silently passing through to CLI and failing late.
    if (activeModel) {
        const modelConfigPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
        try {
            if (fs.existsSync(modelConfigPath)) {
                const config = JSON.parse(fs.readFileSync(modelConfigPath, 'utf8'));
                const engineConfig = config.engines?.[activeEngine];
                if (engineConfig?.available_models && Array.isArray(engineConfig.available_models)) {
                    const allowedModels: string[] = engineConfig.available_models;
                    if (!allowedModels.includes(activeModel)) {
                        throw new Error(
                            `⚠️ **Model Pre-Flight Failed**: Model \`${activeModel}\` is not in the allowed list for engine \`${activeEngine}\`.\n\n` +
                            `**Allowed models**: ${allowedModels.map(m => `\`${m}\``).join(', ')}\n\n` +
                            `Please re-delegate with a valid \`role_model\` or omit it to use the default.`
                        );
                    }
                }
            }
        } catch (e: any) {
            if (e.message?.includes('Model Pre-Flight Failed')) throw e;
        }
    }

    // --- Skill Pre-Flight Check ---
    // If Master specified required_skills, verify they all exist before proceeding.
    // Missing skills → reject with actionable error so Master can create them first.
    let skillContent = '';
    if (masterInfo?.requiredSkills && masterInfo.requiredSkills.length > 0) {
        const { found, missing } = checkRequiredSkills(workspacePath, masterInfo.requiredSkills);
        if (missing.length > 0) {
            throw new Error(
                `⚠️ **Skill Pre-Flight Failed**: Missing ${missing.length} required skill(s): ${missing.map(s => `\`${s}\``).join(', ')}.\n\n` +
                `Master Agent must create these skills first via \`delegate_task_async\` to a skill-creator role, ` +
                `then retry this delegation.\n\n` +
                `Expected path(s):\n${missing.map(s => `- .optimus/skills/${s}/SKILL.md`).join('\n')}`
            );
        }
        // Inject found skills into agent context
        for (const [name, content] of found) {
            skillContent += `\n\n=== SKILL: ${name} ===\n${content}\n=== END SKILL: ${name} ===\n`;
        }
        console.error(`[Orchestrator] Loaded ${found.size} skill(s) for ${role}: ${[...found.keys()].join(', ')}`);
    }

    const adapter = getAdapterForEngine(activeEngine, activeSessionId, activeModel);

    console.error(`[Orchestrator] Resolving Identity for ${role}...`);
    console.error(`[Orchestrator] Selected Stratum: ${resolvedTier}`);
    console.error(`[Orchestrator] Engine: ${activeEngine}, Session: ${activeSessionId || 'New/Ephemeral'}`);

    // T2→T1 instantiation happens AFTER task execution (when session_id is captured).

    const rawTaskText = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8') : taskPath;
    const { sanitized: taskText } = sanitizeExternalContent(rawTaskText, `task:${role}`);

    let personaContext = "";
    if (t1Content) {
        personaContext = parseFrontmatter(t1Content).body.trim();
    } else {
        const formattedRole = role
            .split(/[-_]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
            
        personaContext = `You are a ${formattedRole} expert operating within the Optimus Spartan Swarm. Your purpose is to fulfill tasks autonomously within your specialized domain of expertise.\nAs a dynamically provisioned "T3" agent, apply industry best practices, solve complex problems, and deliver professional-grade results associated with your role.`;
        
        const systemInstructionsPath = path.join(workspacePath, '.optimus', 'config', 'system-instructions.md');
        if (fs.existsSync(systemInstructionsPath)) {
            try {
                const systemInstructions = fs.readFileSync(systemInstructionsPath, 'utf8');
                personaContext += `\n\n--- START WORKSPACE SYSTEM INSTRUCTIONS ---\n${systemInstructions.trim()}\n--- END WORKSPACE SYSTEM INSTRUCTIONS ---`;
            } catch (e: any) { console.error(`[Orchestrator] Warning: failed to read system-instructions.md: ${e.message}`); }
        }
    }

    // Load project memory for injection (after persona, before task)
    const memoryContent = loadProjectMemory(workspacePath);
    const memorySection = memoryContent
        ? `\n\n--- START PROJECT MEMORY ---\nThe following are verified lessons and decisions from this project's history.\nApply them to avoid repeating past mistakes.\n\n${memoryContent}\n--- END PROJECT MEMORY ---`
        : '';

let contextContent = "";
    if (contextFiles && contextFiles.length > 0) {
        contextContent = "\n\n=== CONTEXT FILES ===\n\nThe following files are provided as required context for, and must be strictly adhered to during this task:\n\n";
        for (const cf of contextFiles) {
            const absolutePath = path.resolve(workspacePath, cf);
            if (fs.existsSync(absolutePath)) {
                const rawContent = fs.readFileSync(absolutePath, 'utf8');
                const { sanitized: fileContent } = sanitizeExternalContent(rawContent, `context:${cf}`);
                contextContent += `--- START OF ${cf} ---\n`;
                contextContent += fileContent;
                contextContent += `\n--- END OF ${cf} ---\n\n`;
            } else {
                contextContent += `--- START OF ${cf} ---\n`;
                contextContent += `(File not found at ${absolutePath})\n`;
                contextContent += `--- END OF ${cf} ---\n\n`;
            }
        }
    }

    const trackingIssueHeader = autoIssueNumber
        ? `\n## Tracking Issue\nA GitHub Issue #${autoIssueNumber} has already been created to track this task.\nDO NOT create a new Issue via vcs_create_work_item. Use #${autoIssueNumber} as your Epic/tracking Issue for all sub-delegations.\nPass parent_issue_number: ${autoIssueNumber} to all delegate_task and dispatch_council calls.\n`
        : '';

    const basePrompt = `You are a delegated AI Worker operating under the Spartan Swarm Protocol.
Your Role: ${role}
Identity: ${resolvedTier}

${personaContext ? `--- START PERSONA INSTRUCTIONS ---\n${personaContext}\n--- END PERSONA INSTRUCTIONS ---` : ''}
${memorySection}
Goal: Execute the following task.
System Note: ${personaProof}
${trackingIssueHeader}
Task Description:
${taskText}${contextContent}${skillContent ? `\n\n=== EQUIPPED SKILLS ===\nThe following skills have been loaded for you to reference and follow:\n${skillContent}\n=== END SKILLS ===` : ''}

Please provide your complete execution result below.`;

    const isT3 = resolvedTier.startsWith('T3');

    const lockManager = getLockManager(workspacePath);
    await lockManager.acquireLock(role);
    try {
        await ConcurrencyGovernor.acquire();

        // --- Pre-Flight: Ensure T2 role template exists BEFORE creating T1 ---
        // Logical order: T2 (role definition) → T1 (instance). Never create T1 without T2.
        await ensureT2Role(workspacePath, role, activeEngine, activeModel, masterInfo, currentDepth);

        // --- Pre-Flight: Create T1 instance placeholder from T2 template ---
        // session_id is unknown until after execution, so use a temp name.
        // Post-execution will rename to {role}_{session_id_prefix}.md
        const agentsDir = path.join(workspacePath, '.optimus', 'agents');
        if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });

        const tempId = Math.random().toString(36).slice(2, 10);
        const t1TempPath = t1Path || path.join(agentsDir, `${role}_pending_${tempId}.md`);
        if (!t1Path) {
            // No existing T1 instance found — create a new placeholder
            const t1Template = fs.existsSync(t2Path)
                ? fs.readFileSync(t2Path, 'utf8')
                : `---\nrole: ${role}\n---\n\n# ${role}\n`;
            const t1Instance = updateFrontmatter(t1Template, {
                role: role,
                base_tier: 'T1',
                engine: activeEngine,
                ...(activeModel ? { model: activeModel } : {}),
                session_id: '',
                status: 'running',
                created_at: new Date().toISOString()
            });
            fs.writeFileSync(t1TempPath, t1Instance, 'utf8');
            console.error(`[Orchestrator] T2→T1: Created temp agent placeholder '${role}' at ${path.basename(t1TempPath)}`);
        }

        const extraEnv: Record<string, string> = {
            OPTIMUS_DELEGATION_DEPTH: String(childDepth)
        };
        if (parentIssueNumber !== undefined) {
            extraEnv.OPTIMUS_PARENT_ISSUE = String(parentIssueNumber);
        } else {
            // Explicitly clear inherited env var to prevent stale grandparent references
            extraEnv.OPTIMUS_PARENT_ISSUE = '';
        }
        if (autoIssueNumber !== undefined) {
            extraEnv.OPTIMUS_TRACKING_ISSUE = String(autoIssueNumber);
        }
        const response = await adapter.invoke(basePrompt, activeMode, activeSessionId, undefined, extraEnv);

        // --- Fail-Fast: Detect CLI-level errors in output ---
        // Some CLIs (e.g., Copilot) exit code 0 but output error text to stderr,
        // which gets mixed into the response as "> [LOG] ..." lines.
        // Only treat as fatal if the ACTUAL content (non-LOG lines) is very short,
        // indicating the CLI failed to produce real output.
        const nonLogLines = response.split('\n').filter(l => !l.startsWith('> [LOG]')).join('\n').trim();
        const firstLines = response.slice(0, 500);
        const errorPatterns = [
            /^> \[LOG\] [Ee]rror:/m,
            /^API Error: [45]\d\d/m,
            /^error: option .* is invalid/m,
            /^Error: No authentication/m,
            /^Worker execution failed:/m,
        ];
        const matchedError = errorPatterns.find(p => p.test(firstLines));
        // Only fail if error pattern matched AND there's no meaningful non-log output
        if (matchedError && nonLogLines.length < 100) {
            // Clean up temp T1 — don't leave zombies
            const tempFile = t1Path || path.join(workspacePath, '.optimus', 'agents', `${role}_pending_${tempId}.md`);
            if (fs.existsSync(tempFile) && tempFile.includes('pending_')) {
                try { fs.unlinkSync(tempFile); } catch (e: any) { console.error(`[Orchestrator] Warning: operation failed: ${e.message}`); }
            }
            throw new Error(
                `⚠️ **Delegation Failed (Engine Error)**: Role \`${role}\` on engine \`${activeEngine}\` returned an error.\n\n` +
                `**Error output**:\n\`\`\`\n${firstLines.trim()}\n\`\`\`\n\n` +
                `**Suggested actions**:\n` +
                `- Re-delegate with a different engine (e.g., \`claude-code\` instead of \`github-copilot\`)\n` +
                `- Check if the model name is valid for this engine\n` +
                `- Verify CLI authentication (e.g., \`copilot login\`, \`claude auth\`)`
            );
        }

        // --- Post-Execution: Backfill session_id and rename T1 to final name ---
        const currentT1 = fs.existsSync(t1TempPath) ? t1TempPath : t1Path;
        if (currentT1 && fs.existsSync(currentT1)) {
            const currentStr = fs.readFileSync(currentT1, 'utf8');
            const updates: Record<string, string> = {
                status: 'idle',
                last_invoked: new Date().toISOString()
            };
            const newSessionId = adapter.lastSessionId;
            if (newSessionId) {
                updates.session_id = newSessionId;
            }
            const updated = updateFrontmatter(currentStr, updates);

            // Rename to final name: {role}_{session_id_prefix}.md
            const sessionPrefix = (newSessionId || tempId).slice(0, 8);
            const finalT1Path = path.join(agentsDir, `${role}_${sessionPrefix}.md`);
            fs.writeFileSync(finalT1Path, updated, 'utf8');
            // Clean up temp/old file if path changed
            if (currentT1 !== finalT1Path && fs.existsSync(currentT1)) {
                try { fs.unlinkSync(currentT1); } catch (e: any) { console.error(`[Orchestrator] Warning: operation failed: ${e.message}`); }
            }
            console.error(`[Orchestrator] T1 finalized: '${role}' → ${path.basename(finalT1Path)}, session=${newSessionId || 'none'}, status=idle`);
        }

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(outputPath, response, 'utf8');

        // Track T3 success AFTER we know execution succeeded
        if (isT3) {
            trackT3Usage(workspacePath, role, true, activeEngine, activeModel);
        }

        return `✅ **Task Delegation Successful**\n\n**Agent Identity Resolved**: ${resolvedTier}\n**Engine**: ${activeEngine}\n**Session ID**: ${adapter.lastSessionId || 'Ephemeral'}\n\n**System Note**: ${personaProof}\n\nAgent has finished execution. Check standard output at \`${outputPath}\`.`;
    } catch (e: any) {
        // Track T3 failures too
        if (isT3) {
            trackT3Usage(workspacePath, role, false, activeEngine, activeModel);
        }
        // Check quarantine threshold: 3+ consecutive failures with 0 successes
        const log = loadT3UsageLog(workspacePath);
        const entry = log[role];
        if (entry && entry.consecutive_failures >= 3 && entry.successes === 0) {
            const t2RolePath = path.join(workspacePath, '.optimus', 'roles', `${sanitizeRoleName(role)}.md`);
            if (fs.existsSync(t2RolePath)) {
                const t2Content = fs.readFileSync(t2RolePath, 'utf8');
                const quarantined = updateFrontmatter(t2Content, {
                    status: 'quarantined',
                    quarantined_at: new Date().toISOString()
                });
                fs.writeFileSync(t2RolePath, quarantined, 'utf8');
                console.error(`[Meta-Immune] Role '${role}' quarantined after ${entry.consecutive_failures} consecutive failures with 0 successes`);
            }
        }
        throw new Error(`Worker execution failed for role '${role}' on engine '${activeEngine}': ${e.message}`);
    } finally {
        ConcurrencyGovernor.release();
        lockManager.releaseLock(role);
    }
}

/**
 * Spawns a single expert worker process for council review.
 */
export async function spawnWorker(role: string, proposalPath: string, outputPath: string, sessionId: string, workspacePath: string, parentDepth?: number, parentIssueNumber?: number, roleDescription?: string): Promise<string> {
    try {
        console.error(`[Spawner] Launching Real Worker ${role} for council review`);
        const masterInfo: MasterRoleInfo | undefined = roleDescription ? { description: roleDescription } : undefined;
        return await delegateTaskSingle(role, `Please read the architectural PROPOSAL located at: ${proposalPath}.
Provide your expert critique from the perspective of your role (${role}). Identify architectural bottlenecks, DX friction, security risks, or asynchronous race conditions. Conclude with a recommendation: Reject, Accept, or Hybrid.`, outputPath, sessionId, workspacePath, undefined, masterInfo, parentDepth, parentIssueNumber);
    } catch (err: any) {
        console.error(`[Spawner] Worker ${role} failed to start:`, err);
        return `❌ ${role}: exited with errors (${err.message}).`;
    }
}

/**
 * Dispatches the council of experts concurrently.
 */
export async function dispatchCouncilConcurrent(roles: string[], proposalPath: string, reviewsPath: string, timestampId: string, workspacePath: string, parentDepth?: number, parentIssueNumber?: number, roleDescriptions?: Record<string, string>): Promise<string[]> {
  const promises = roles.map(role => {
    const outputPath = path.join(reviewsPath, `${role}_review.md`);
    return spawnWorker(role, proposalPath, outputPath, `${timestampId}_${Math.random().toString(36).slice(2,8)}`, workspacePath, parentDepth, parentIssueNumber, roleDescriptions?.[role]);
  });

  const results = await Promise.allSettled(promises);
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
          succeeded.push((results[i] as PromiseFulfilledResult<string>).value);
      } else {
          const reason = (results[i] as PromiseRejectedResult).reason;
          failed.push(`${roles[i]}: ${reason?.message || 'Unknown error'}`);
          console.error(`[Council] Worker '${roles[i]}' failed: ${reason?.message}`);
      }
  }
  if (failed.length > 0) {
      const failSummary = `# Council Partial Failure Report\n\n${failed.map(f => `- ${f}`).join('\n')}\n`;
      fs.writeFileSync(path.join(reviewsPath, 'FAILURES.md'), failSummary, 'utf8');
  }
  return succeeded;
}