import fs from "fs";
import path from "path";
import os from "os";
import { AgentAdapter } from "../adapters/AgentAdapter";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";

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

function updateFrontmatter(content: string, updates: Record<string, string>): string {
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
    lastUsed: string;
    engine: string;
    model?: string;
}

function getT3UsageLogPath(workspacePath: string): string {
    return path.join(workspacePath, '.optimus', 'state', 't3-usage-log.json');
}

function loadT3UsageLog(workspacePath: string): Record<string, T3UsageEntry> {
    const logPath = getT3UsageLogPath(workspacePath);
    try {
        if (fs.existsSync(logPath)) {
            return JSON.parse(fs.readFileSync(logPath, 'utf8'));
        }
    } catch {}
    return {};
}

function saveT3UsageLog(workspacePath: string, log: Record<string, T3UsageEntry>): void {
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
            log[role] = { role, invocations: 0, successes: 0, failures: 0, lastUsed: '', engine, model };
        }
        log[role].invocations++;
        if (success) log[role].successes++;
        else log[role].failures++;
        log[role].lastUsed = new Date().toISOString();
        log[role].engine = engine;
        if (model) log[role].model = model;
        saveT3UsageLog(workspacePath, log);
    }).catch(() => {});
}

const PRECIPITATION_THRESHOLD = 3;
const PRECIPITATION_SUCCESS_RATE = 0.8;

/**
 * Check if a T3 role should be precipitated to T2 based on usage metrics.
 * If threshold is met, auto-generate the T2 role template.
 */
function checkAndPrecipitate(workspacePath: string, role: string, engine: string, model?: string): string | null {
    const safeRole = sanitizeRoleName(role);
    const log = loadT3UsageLog(workspacePath);
    const entry = log[safeRole];
    if (!entry || entry.invocations < PRECIPITATION_THRESHOLD) return null;
    
    const successRate = entry.successes / entry.invocations;
    if (successRate < PRECIPITATION_SUCCESS_RATE) return null;

    const t2Dir = path.join(workspacePath, '.optimus', 'roles');
    const t2Path = path.join(t2Dir, `${safeRole}.md`);
    if (fs.existsSync(t2Path)) return null; // Already a T2

    if (!fs.existsSync(t2Dir)) fs.mkdirSync(t2Dir, { recursive: true });

    const formattedRole = safeRole
        .split(/[-_]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    const template = `---
role: ${safeRole}
tier: T2
description: "Auto-precipitated from T3 after ${entry.successes} successes in ${entry.invocations} invocations"
engine: ${engine}
model: ${model || 'claude-opus-4.6-1m'}
precipitated: ${new Date().toISOString()}
---

# ${formattedRole}

You are a **${formattedRole}** expert operating within the Optimus Spartan Swarm.
This role was automatically promoted from T3 (dynamic outsourcing) to T2 (project default) based on consistent successful usage (${entry.successes}/${entry.invocations} success rate).

Apply industry best practices, solve complex problems, and deliver professional-grade results within your specialized domain of expertise.
`;

    fs.writeFileSync(t2Path, template, 'utf8');
    console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 at ${t2Path} (${entry.successes}/${entry.invocations} success rate)`);
    return t2Path;
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
        } catch {
            // Best-effort; in-memory lock is the primary mechanism
        }
    }

    private deleteLockFile(role: string): void {
        try {
            fs.unlinkSync(this.lockFilePath(role));
        } catch {
            // File may already be gone
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
                } catch {
                    // Malformed lock file — remove it
                    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
                }
            }
        } catch {
            // Best-effort cleanup
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
    const engineIndex = segments.findIndex(segment => segment === 'claude-code' || segment === 'copilot-cli');

    if (engineIndex === -1) {
        return { role: path.basename(roleArg) };
    }

    const role = segments.slice(0, engineIndex).join('_') || path.basename(roleArg);
    const engine = segments[engineIndex];
    const model = segments.slice(engineIndex + 1).join('_');
    return { role, engine, model };
}

function getAdapterForEngine(engine: string, sessionId?: string, model?: string): AgentAdapter {
    if (engine === 'copilot-cli') {
        return new GitHubCopilotAdapter(sessionId, '🛸 GitHub Copilot', model);
    }
    return new ClaudeCodeAdapter(sessionId, '🦖 Claude Code', model);
}

/**
 * Executes a single task delegation synchronously.
 */
export async function delegateTaskSingle(roleArg: string, taskPath: string, outputPath: string, _fallbackSessionId: string, workspacePath: string, contextFiles?: string[]): Promise<string> {
    const parsedRole = parseRoleSpec(roleArg);
    const role = sanitizeRoleName(parsedRole.role);
    
    // Auto-migrate legacy folder `.optimus/personas` to `.optimus/agents`
    const legacyT1Dir = path.join(workspacePath, '.optimus', 'personas');
    const t1Dir = path.join(workspacePath, '.optimus', 'agents');
    if (fs.existsSync(legacyT1Dir) && !fs.existsSync(t1Dir)) {
        try { fs.renameSync(legacyT1Dir, t1Dir); } catch(e) {}
    }
    
    const t2Dir = path.join(workspacePath, '.optimus', 'roles');
    if (!fs.existsSync(t2Dir)) {
        fs.mkdirSync(t2Dir, { recursive: true });
    }

    // Lazy load/sync default roles to project profile
    const builtInRolesDir = path.join(__dirname, '..', '..', 'optimus-plugin', 'roles');
    if (fs.existsSync(builtInRolesDir)) {
        const builtinFiles = fs.readdirSync(builtInRolesDir);
        for (const file of builtinFiles) {
            if (file.endsWith('.md')) {
                const projectFilePath = path.join(t2Dir, file);
                if (!fs.existsSync(projectFilePath)) {
                    try { fs.copyFileSync(path.join(builtInRolesDir, file), projectFilePath); } catch(e) {}
                }
            }
        }
    }

    const t1Path = path.join(t1Dir, `${role}.md`);
    const t2Path = path.join(t2Dir, `${role}.md`);

    let activeEngine = parsedRole.engine || 'claude-code';
    let activeModel = parsedRole.model;
    let activeSessionId: string | undefined = undefined;

    let t1Content = '';
    let shouldLocalize = false;
    let resolvedTier = 'T3 (Zero-Shot Outsource)';
    let personaProof = 'No dedicated role template found in T2 or T1. Using T3 generic prompt.';

    if (fs.existsSync(t1Path)) {
        t1Content = fs.readFileSync(t1Path, 'utf8');
        resolvedTier = `T1 (Agent Instance -> ${role}.md)`;
        personaProof = `Found local project agent state: ${t1Path}`;
    } else if (fs.existsSync(t2Path)) {
        t1Content = fs.readFileSync(t2Path, 'utf8');
        shouldLocalize = true;
        resolvedTier = `T2 (Role Template -> ${role}.md)`;
        personaProof = `Found globally promoted Role template: ${t2Path}`;
    }

    if (t1Content) {
        const fm = parseFrontmatter(t1Content);
        if (fm.frontmatter.engine) activeEngine = fm.frontmatter.engine;
        if (fm.frontmatter.session_id) activeSessionId = fm.frontmatter.session_id;
        if (fm.frontmatter.model) activeModel = fm.frontmatter.model;
    }

    const adapter = getAdapterForEngine(activeEngine, activeSessionId, activeModel);

    console.error(`[Orchestrator] Resolving Identity for ${role}...`);
    console.error(`[Orchestrator] Selected Stratum: ${resolvedTier}`);
    console.error(`[Orchestrator] Engine: ${activeEngine}, Session: ${activeSessionId || 'New/Ephemeral'}`);

    // Removed the "Promotion to T1" behavior so T2 strictly remains a global fallback 
    // and does not pollute the workspace-level .optimus mapping unless explicitly overridden by user.

    const taskText = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8') : taskPath;

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
            } catch (e) {}
        }
    }

let contextContent = "";
    if (contextFiles && contextFiles.length > 0) {
        contextContent = "\n\n=== CONTEXT FILES ===\n\nThe following files are provided as required context for, and must be strictly adhered to during this task:\n\n";
        for (const cf of contextFiles) {
            const absolutePath = path.resolve(workspacePath, cf);
            if (fs.existsSync(absolutePath)) {
                contextContent += `--- START OF ${cf} ---\n`;
                contextContent += fs.readFileSync(absolutePath, 'utf8');
                contextContent += `\n--- END OF ${cf} ---\n\n`;
            } else {
                contextContent += `--- START OF ${cf} ---\n`;
                contextContent += `(File not found at ${absolutePath})\n`;
                contextContent += `--- END OF ${cf} ---\n\n`;
            }
        }
    }

    const basePrompt = `You are a delegated AI Worker operating under the Spartan Swarm Protocol.
Your Role: ${role}
Identity: ${resolvedTier}

${personaContext ? `--- START PERSONA INSTRUCTIONS ---\n${personaContext}\n--- END PERSONA INSTRUCTIONS ---` : ''}

Goal: Execute the following task.
System Note: ${personaProof}

Task Description:
${taskText}${contextContent}

Please provide your complete execution result below.`;

    const isT3 = resolvedTier.startsWith('T3');

    const lockManager = getLockManager(workspacePath);
    await lockManager.acquireLock(role);
    try {
        await ConcurrencyGovernor.acquire();
        const response = await adapter.invoke(basePrompt, 'agent');

        // --- Core Protocol: Native Session Capture & Binding ---
        if (adapter.lastSessionId && fs.existsSync(t1Path)) {
            const currentStr = fs.readFileSync(t1Path, 'utf8');
            const updated = updateFrontmatter(currentStr, {
                engine: activeEngine,
                session_id: adapter.lastSessionId
            });
            fs.writeFileSync(t1Path, updated, 'utf8');
            console.error(`[Orchestrator] Captured native session ID '${adapter.lastSessionId}' to ${t1Path}`);
        }

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(outputPath, response, 'utf8');

        // --- T3 Usage Tracking & Auto-Precipitation ---
        if (isT3) {
            trackT3Usage(workspacePath, role, true, activeEngine, activeModel);
            const precipitated = checkAndPrecipitate(workspacePath, role, activeEngine, activeModel);
            if (precipitated) {
                return `✅ **Task Delegation Successful**\n\n**Agent Identity Resolved**: ${resolvedTier}\n**Engine**: ${activeEngine}\n**Session ID**: ${adapter.lastSessionId || 'Ephemeral'}\n\n**System Note**: ${personaProof}\n\n🎉 **Precipitation**: T3 role \`${role}\` has been auto-promoted to T2! Template created at \`${precipitated}\`.\n\nAgent has finished execution. Check standard output at \`${outputPath}\`.`;
            }
        }

        return `✅ **Task Delegation Successful**\n\n**Agent Identity Resolved**: ${resolvedTier}\n**Engine**: ${activeEngine}\n**Session ID**: ${adapter.lastSessionId || 'Ephemeral'}\n\n**System Note**: ${personaProof}\n\nAgent has finished execution. Check standard output at \`${outputPath}\`.`;
    } catch (e: any) {
        // Track T3 failures too
        if (isT3) {
            trackT3Usage(workspacePath, role, false, activeEngine, activeModel);
        }
        throw new Error(`Worker execution failed: ${e.message}`);
    } finally {
        ConcurrencyGovernor.release();
        lockManager.releaseLock(role);
    }
}

/**
 * Spawns a single expert worker process for council review.
 */
export async function spawnWorker(role: string, proposalPath: string, outputPath: string, sessionId: string, workspacePath: string): Promise<string> {
    try {
        console.error(`[Spawner] Launching Real Worker ${role} for council review`);
        return await delegateTaskSingle(role, `Please read the architectural PROPOSAL located at: ${proposalPath}. 
Provide your expert critique from the perspective of your role (${role}). Identify architectural bottlenecks, DX friction, security risks, or asynchronous race conditions. Conclude with a recommendation: Reject, Accept, or Hybrid.`, outputPath, sessionId, workspacePath);
    } catch (err: any) {
        console.error(`[Spawner] Worker ${role} failed to start:`, err);
        return `❌ ${role}: exited with errors (${err.message}).`;
    }
}

/**
 * Dispatches the council of experts concurrently.
 */
export async function dispatchCouncilConcurrent(roles: string[], proposalPath: string, reviewsPath: string, timestampId: string, workspacePath: string): Promise<string[]> {
  const promises = roles.map(role => {
    const outputPath = path.join(reviewsPath, `${role}_review.md`);
    return spawnWorker(role, proposalPath, outputPath, `${timestampId}_${Math.random().toString(36).slice(2,8)}`, workspacePath);
  });

  return Promise.all(promises);
}
