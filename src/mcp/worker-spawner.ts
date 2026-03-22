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
import crypto from "crypto";
import { AgentAdapter } from "../adapters/AgentAdapter";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";
import { AcpAdapter } from "../adapters/AcpAdapter";
import { AcpProcessPool } from "../utils/acpProcessPool";
import { MAX_DELEGATION_DEPTH } from "../constants";
import { sanitizeExternalContent } from "../utils/sanitizeExternalContent";
import { registerRole } from "../utils/resolveRoleName";
import { getAutomationCapabilityMode, getClaudePermissionModeForPolicy, normalizeAutomationPolicy } from "../utils/automationPolicy";
import { loadFilteredMemory, migrateMemoryFile, loadUserMemory } from "../managers/MemoryManager";
import { TaskManifestManager } from "../managers/TaskManifestManager";
import { resolveOptimusPath } from '../utils/worktree';
import { AvailableAgentsConfig, parseAvailableAgentsConfig } from "../types/AvailableAgentsConfig";

export interface EngineAutomationExplanation {
    declared: boolean;
    mode: string;
    continuation: string;
    maxContinues?: number;
}

export interface EngineTransportExplanation {
    protocol: 'cli' | 'acp';
    configured: boolean;
    executable?: string;
    args: string[];
    supportsRequestedMode: boolean;
    supportsRequestedContinuation: boolean;
    supportsRequestedPolicy: boolean;
    capabilities: {
        automation_modes: string[];
        automation_continuations: string[];
    };
    reason: string;
}

export interface EngineResolutionExplanation {
    engine: string;
    configuredProtocol: 'cli' | 'acp' | 'auto';
    preferredProtocol: 'cli' | 'acp';
    requestedAutomation: EngineAutomationExplanation;
    availableModels: string[];
    status?: string;
    selectedProtocol: 'cli' | 'acp' | null;
    selectedTransport: { protocol: 'cli' | 'acp'; executable?: string; args: string[] } | null;
    selectionReason: string;
    candidates: EngineTransportExplanation[];
    error?: string;
}

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

interface RoleTemplateCandidate {
    path: string;
    rawContent: string;
    content: string;
    frontmatter: Record<string, string>;
    body: string;
    score: number;
}

function scoreRoleTemplateCandidate(role: string, candidatePath: string, preferredPath: string, frontmatter: Record<string, string>, body: string): number {
    const bodyLines = body.split('\n').filter(line => line.trim().length > 0).length;
    let score = Math.min(bodyLines, 50);
    if (frontmatter.role === role) score += 100;
    if (frontmatter.tier === 'T2') score += 30;
    if (frontmatter.description) score += 20;
    if (frontmatter.engine) score += 20;
    if (frontmatter.model) score += 5;
    if (frontmatter.base_tier === 'T1') score -= 20;
    if (candidatePath === preferredPath) score += 1;
    return score;
}

function extractBestFrontmatterDocument(content: string, role: string, candidatePath: string, preferredPath: string): Omit<RoleTemplateCandidate, 'path' | 'rawContent'> | null {
    const normalized = content.replace(/\r\n/g, '\n');
    const startIndices = [...normalized.matchAll(/^---\n/gm)].map(match => match.index ?? 0);
    let best: Omit<RoleTemplateCandidate, 'path' | 'rawContent'> | null = null;

    for (let i = 0; i < startIndices.length; i++) {
        const start = startIndices[i];
        const document = normalized.slice(start).trim();
        const parsed = parseFrontmatter(document);
        if (Object.keys(parsed.frontmatter).length === 0) continue;

        const candidate: Omit<RoleTemplateCandidate, 'path' | 'rawContent'> = {
            content: document,
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            score: scoreRoleTemplateCandidate(role, candidatePath, preferredPath, parsed.frontmatter, parsed.body)
        };

        if (!best || candidate.score > best.score) {
            best = candidate;
        }
    }

    return best;
}

function loadBestRoleTemplate(workspacePath: string, role: string): RoleTemplateCandidate | null {
    const rolesDir = resolveOptimusPath(workspacePath, 'roles');
    const flatPath = path.join(rolesDir, `${role}.md`);
    const candidatePaths = [
        flatPath,
        path.join(rolesDir, role, 'ROLE.md')
    ];

    const candidates: RoleTemplateCandidate[] = [];
    for (const candidatePath of candidatePaths) {
        if (!fs.existsSync(candidatePath)) continue;
        try {
            const rawContent = fs.readFileSync(candidatePath, 'utf8');
            const extracted = extractBestFrontmatterDocument(rawContent, role, candidatePath, flatPath);
            const parsed = extracted ? { frontmatter: extracted.frontmatter, body: extracted.body } : parseFrontmatter(rawContent);
            const canonicalContent = extracted?.content ?? rawContent;
            candidates.push({
                path: candidatePath,
                rawContent,
                content: canonicalContent,
                frontmatter: parsed.frontmatter,
                body: parsed.body,
                score: extracted?.score ?? scoreRoleTemplateCandidate(role, candidatePath, flatPath, parsed.frontmatter, parsed.body)
            });
        } catch (e: any) {
            console.error(`[T2 Guard] Warning: failed to read role template '${candidatePath}': ${e.message}`);
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
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

// ─── ACP CLI Auto-Discovery ───

/**
 * Auto-discover ACP CLI executables from VS Code extensions directory.
 * Scans ~/.vscode/extensions/ for known vendor extension patterns and returns
 * the newest installed version's CLI entry point.
 * 
 * Supported engines:
 *   - qwen-code: qwenlm.qwen-code-vscode-ide-companion-{version}/dist/qwen-cli/cli.js
 */
const ACP_DISCOVERY_MAP: Record<string, { extensionPattern: string; cliRelPath: string }> = {
    'qwen-code': { extensionPattern: 'qwenlm.qwen-code*', cliRelPath: 'dist/qwen-cli/cli.js' },
};

function discoverAcpCli(engine: string): { executable: string; args: string[] } | null {
    const discovery = ACP_DISCOVERY_MAP[engine];
    if (!discovery) return null;

    const homeDir = process.env.USERPROFILE || process.env.HOME || '';
    const extensionsDir = path.join(homeDir, '.vscode', 'extensions');

    if (!fs.existsSync(extensionsDir)) return null;

    try {
        const matches = fs.readdirSync(extensionsDir)
            .filter(d => {
                // Simple glob: convert 'qwenlm.qwen-code*' to startsWith check
                const prefix = discovery.extensionPattern.replace('*', '');
                return d.startsWith(prefix);
            })
            .map(d => path.join(extensionsDir, d))
            .filter(d => {
                try { return fs.statSync(d).isDirectory(); } catch { return false; }
            })
            .sort() // Lexicographic sort — higher version numbers come last
            .reverse(); // Newest first

        for (const extDir of matches) {
            const cliPath = path.join(extDir, discovery.cliRelPath);
            if (fs.existsSync(cliPath)) {
                return { executable: 'node', args: [cliPath] };
            }
        }
    } catch (e: any) {
        console.error(`[Engine] ACP auto-discovery error for ${engine}: ${e.message}`);
    }

    return null;
}

// ─── Output Trace Stripping ───

/**
 * Strip tool-call trace lines from adapter output before writing to artifact files.
 * PersistentAgentAdapter's structured output includes process traces like:
 *   • powershell  / • view  / • report_intent  / ✓ result  / ✗ error
 * These are useful for debugging but pollute artifact files consumed by other agents.
 * 
 * Strategy: detect trace-heavy output and extract the clean content after the trace block.
 * If output has no traces, return as-is.
 */
function stripTraceLines(output: string): string {
    const lines = output.split('\n');

    // Quick check: if the output doesn't start with trace patterns, return as-is
    const tracePattern = /^[•✓✗↳] |^↳ /;
    if (lines.length === 0 || !tracePattern.test(lines[0].trim())) {
        return output;
    }

    // Find the last trace line, then take everything after it
    let lastTraceIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (tracePattern.test(trimmed) || trimmed === '' && lastTraceIdx === i - 1) {
            lastTraceIdx = i;
        }
    }

    if (lastTraceIdx === -1) {
        return output;
    }

    // Everything after the last trace block is the agent's actual summary/response
    const cleanContent = lines.slice(lastTraceIdx + 1).join('\n').trim();

    // If clean content is substantial, use it; otherwise fall back to full output
    // (some agents might only produce traces with no clean section)
    if (cleanContent.length > 50) {
        return cleanContent;
    }

    return output;
}

/**
 * Normalize a Windows path to use forward slashes for safe embedding in agent prompts.
 * Backslashes in JSON strings must be escaped (\\), and LLMs sometimes fail to do this
 * when re-using paths from their prompt context in tool call arguments. Forward slashes
 * are accepted by the Windows API and Node.js, and require no JSON escaping.
 */
function normalizePathForAgent(p: string): string {
    return p.replace(/\\/g, '/');
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
    return resolveOptimusPath(workspacePath, 'state', 't3-usage-log.json');
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

// ─── Engine+Model Health Tracking ───

/** Time-to-live for unhealthy status: after this period, allow a probe attempt */
const ENGINE_HEALTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

// File-level mutex for engine-health.json (same pattern as t3LogMutex)
let engineHealthMutex: Promise<void> = Promise.resolve();

interface EngineHealthEntry {
    engine: string;
    model: string;
    invocations: number;
    successes: number;
    failures: number;
    consecutive_failures: number;
    last_success: string; // ISO timestamp
    last_failure: string; // ISO timestamp
    status: 'healthy' | 'degraded' | 'unhealthy';
}

function getEngineHealthPath(workspacePath: string): string {
    return resolveOptimusPath(workspacePath, 'state', 'engine-health.json');
}

function loadEngineHealth(workspacePath: string): Record<string, EngineHealthEntry> {
    const healthPath = getEngineHealthPath(workspacePath);
    try {
        if (fs.existsSync(healthPath)) {
            return JSON.parse(fs.readFileSync(healthPath, 'utf8'));
        }
    } catch (e: any) {
        console.error(`[EngineHealth] Warning: failed to read engine-health.json: ${e.message}`);
    }
    return {};
}

function saveEngineHealth(workspacePath: string, health: Record<string, EngineHealthEntry>): void {
    const healthPath = getEngineHealthPath(workspacePath);
    const dir = path.dirname(healthPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = healthPath + '.tmp.' + process.pid;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(health, null, 2), 'utf8');
        // Windows-safe atomic replace: unlink target first, then rename
        try { fs.unlinkSync(healthPath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        fs.renameSync(tmpPath, healthPath);
    } catch (err: any) {
        // Clean up temp file on failure
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
    }
}

function computeHealthStatus(consecutiveFailures: number): 'healthy' | 'degraded' | 'unhealthy' {
    if (consecutiveFailures >= 3) return 'unhealthy';
    if (consecutiveFailures >= 2) return 'degraded';
    return 'healthy';
}

function trackEngineHealth(workspacePath: string, engine: string, model: string, success: boolean): void {
    engineHealthMutex = engineHealthMutex.then(() => {
        const health = loadEngineHealth(workspacePath);
        const key = `${engine}:${model}`;
        if (!health[key]) {
            health[key] = {
                engine,
                model,
                invocations: 0,
                successes: 0,
                failures: 0,
                consecutive_failures: 0,
                last_success: '',
                last_failure: '',
                status: 'healthy'
            };
        }
        const entry = health[key];
        entry.invocations++;
        if (success) {
            entry.successes++;
            entry.consecutive_failures = 0;
            entry.last_success = new Date().toISOString();
        } else {
            entry.failures++;
            entry.consecutive_failures++;
            entry.last_failure = new Date().toISOString();
        }
        const oldStatus = entry.status;
        entry.status = computeHealthStatus(entry.consecutive_failures);
        if (oldStatus !== entry.status) {
            console.error(`[EngineHealth] ${engine}/${model} status transition: ${oldStatus} → ${entry.status} (consecutive_failures=${entry.consecutive_failures})`);
        }
        saveEngineHealth(workspacePath, health);
    }).catch((err: any) => {
        console.error(`[EngineHealth] Failed to update engine health for ${engine}:${model}: ${err.message}`);
    });
}

function resolveHealthyModel(workspacePath: string, engine: string, model: string): { engine: string; model: string } {
    const health = loadEngineHealth(workspacePath);
    const key = `${engine}:${model}`;
    const entry = health[key];

    // If no entry or healthy → return as-is
    if (!entry || entry.status === 'healthy' || entry.status === 'degraded') {
        return { engine, model };
    }

    // Unhealthy — check TTL for self-heal probe
    if (entry.last_failure) {
        const elapsed = Date.now() - new Date(entry.last_failure).getTime();
        if (elapsed > ENGINE_HEALTH_TTL_MS) {
            console.error(`[EngineHealth] ${engine}/${model} TTL expired (${Math.round(elapsed / 60000)}min since last failure). Resetting to healthy for probe.`);
            entry.status = 'healthy';
            entry.consecutive_failures = 0;
            saveEngineHealth(workspacePath, health);
            return { engine, model };
        }
    }

    // Unhealthy within TTL — find fallback
    const { engines: availEngines, models: availModels } = loadValidEnginesAndModels(workspacePath);

    // 1. Try other models on the same engine
    const sameEngineModels = availModels[engine] || [];
    for (const candidateModel of sameEngineModels) {
        if (candidateModel === model) continue;
        const candidateKey = `${engine}:${candidateModel}`;
        const candidateEntry = health[candidateKey];
        if (!candidateEntry || candidateEntry.status !== 'unhealthy') {
            console.error(`[EngineHealth] Fallback selected: ${engine}/${candidateModel} (same engine, replacing unhealthy ${engine}/${model})`);
            return { engine, model: candidateModel };
        }
    }

    // 2. Try other engines
    for (const candidateEngine of availEngines) {
        if (candidateEngine === engine) continue;
        const candidateModels = availModels[candidateEngine] || [];
        for (const candidateModel of candidateModels) {
            const candidateKey = `${candidateEngine}:${candidateModel}`;
            const candidateEntry = health[candidateKey];
            if (!candidateEntry || candidateEntry.status !== 'unhealthy') {
                console.error(`[EngineHealth] Fallback selected: ${candidateEngine}/${candidateModel} (cross-engine, replacing unhealthy ${engine}/${model})`);
                return { engine: candidateEngine, model: candidateModel };
            }
        }
    }

    // 3. All combos unhealthy — escape hatch: return original (R3.4)
    console.error(`[EngineHealth] All engine+model combos are unhealthy. Proceeding with original ${engine}/${model} as last resort.`);
    return { engine, model };
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
        const skillPath = resolveOptimusPath(workspacePath, 'skills', resolvedSkill, 'SKILL.md');
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
    const configPath = resolveOptimusPath(workspacePath, 'config', 'available-agents.json');
    try {
        const config = readAvailableAgentsConfigFile(configPath);
        if (config) {
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

const AVAILABLE_AGENTS_WARNING_CACHE = new Set<string>();

function emitAvailableAgentsConfigWarnings(configPath: string, config: any): void {
    const engines = config?.engines;
    if (!engines || typeof engines !== 'object') {
        return;
    }

    for (const [engineName, engineConfig] of Object.entries<any>(engines)) {
        const transports: Array<{ label: string; protocol: 'acp'; config: any }> = [];
        if (engineConfig?.protocol === 'acp') {
            transports.push({ label: 'protocol', protocol: 'acp', config: engineConfig });
        }
        if (engineConfig?.protocol === 'auto' && engineConfig?.acp && typeof engineConfig.acp === 'object') {
            transports.push({ label: 'acp', protocol: 'acp', config: engineConfig.acp });
        }

        for (const transport of transports) {
            const transportPath = typeof transport.config?.path === 'string' ? transport.config.path.trim().toLowerCase() : '';
            const hasExplicitArgs = Array.isArray(transport.config?.args);
            const looksLikeCopilot = engineName.toLowerCase().includes('copilot') || transportPath === 'copilot' || transportPath.endsWith('/copilot') || transportPath.endsWith('\\copilot');
            if (!looksLikeCopilot || hasExplicitArgs) {
                continue;
            }

            const warningKey = `${configPath}:${engineName}:${transport.label}:copilot-acp-default-stdio`;
            if (AVAILABLE_AGENTS_WARNING_CACHE.has(warningKey)) {
                continue;
            }
            AVAILABLE_AGENTS_WARNING_CACHE.add(warningKey);
            console.error(
                `[Config] Warning: engine '${engineName}' declares Copilot ACP via '${transport.label}' transport with path 'copilot' and no explicit args. ` +
                `Optimus will default to '--acp --stdio'; do not infer ACP capability limits from the top-level 'copilot --help' summary alone.`
            );
        }
    }
}

export function readAvailableAgentsConfigFile(configPath: string): AvailableAgentsConfig | null {
    if (!fs.existsSync(configPath)) return null;
    const config = parseAvailableAgentsConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    emitAvailableAgentsConfigWarnings(configPath, config);
    return config;
}

export function loadAvailableAgentsConfig(workspacePath?: string): AvailableAgentsConfig | null {
    if (!workspacePath) return null;
    const configPath = resolveOptimusPath(workspacePath, 'config', 'available-agents.json');
    try {
        return readAvailableAgentsConfigFile(configPath);
    } catch (e: any) {
        console.error(`[EngineValidation] Warning: failed to read available-agents.json: ${e.message}`);
    }
    return null;
}

function getEngineConfig(engine: string, workspacePath?: string): any | null {
    return loadAvailableAgentsConfig(workspacePath)?.engines?.[engine] || null;
}

function getConfiguredEngineNames(workspacePath?: string): string[] {
    return Object.keys(loadAvailableAgentsConfig(workspacePath)?.engines || {});
}

function getTransportConfig(engineConfig: any, protocol: 'cli' | 'acp'): any {
    if (!engineConfig) return null;
    if (engineConfig.protocol === 'auto') {
        return engineConfig[protocol] || null;
    }
    const explicitProtocol = engineConfig.protocol === 'acp' ? 'acp' : 'cli';
    if (explicitProtocol !== protocol) return null;
    // Prefer protocol sub-object if it exists (has capabilities), else fall back to parent
    return engineConfig[protocol] || engineConfig;
}

function getDefaultProtocolForEngine(engine: string): 'cli' | 'acp' {
    return engine === 'acp' || engine.startsWith('acp-') ? 'acp' : 'cli';
}

function getConfiguredProtocol(engine: string, engineConfig: any): 'cli' | 'acp' | 'auto' {
    if (engineConfig?.protocol === 'auto') {
        return 'auto';
    }
    return (engineConfig?.protocol || getDefaultProtocolForEngine(engine)) === 'acp' ? 'acp' : 'cli';
}

function getPreferredProtocol(engineConfig: any): 'cli' | 'acp' {
    return engineConfig?.preferred_protocol === 'cli' ? 'cli' : 'acp';
}

function getDocumentedDefaultAcpArgs(engine: string): string[] {
    // GitHub Copilot ACP is a documented public-preview transport. The summary
    // `copilot --help` output may only advertise `--acp`, while the ACP docs
    // also document `--stdio` / `--port` server modes. Optimus runs ACP over
    // stdio, so default Copilot ACP launches to `copilot --acp --stdio` unless
    // config explicitly overrides the transport args.
    if (engine.toLowerCase().includes('copilot')) {
        return ['--acp', '--stdio'];
    }
    return ['--acp'];
}

function getRequestedAutomationMode(engineConfig: any): string | undefined {
    if (!engineConfig?.automation || typeof engineConfig.automation !== 'object') {
        return undefined;
    }
    return getAutomationCapabilityMode(engineConfig.automation);
}

function getRequestedAutomationContinuation(engineConfig: any): string | undefined {
    if (!engineConfig?.automation || typeof engineConfig.automation !== 'object') {
        return undefined;
    }
    return normalizeAutomationPolicy(engineConfig.automation).continuation;
}

function getSupportedAutomationModes(transportConfig: any): string[] {
    if (!Array.isArray(transportConfig?.capabilities?.automation_modes)) {
        return [];
    }
    return transportConfig.capabilities.automation_modes.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0);
}

function getSupportedAutomationContinuations(transportConfig: any): string[] {
    if (!Array.isArray(transportConfig?.capabilities?.automation_continuations)) {
        return [];
    }
    return transportConfig.capabilities.automation_continuations.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0);
}

function transportSupportsAutomationMode(protocol: 'cli' | 'acp', transportConfig: any, requestedMode: string | undefined): boolean {
    if (!transportConfig) return false;
    if (!requestedMode) return true;
    const supportedModes = getSupportedAutomationModes(transportConfig);
    if (supportedModes.length > 0) {
        return supportedModes.includes(requestedMode);
    }
    if (protocol === 'acp') {
        return requestedMode === 'auto-approve';
    }
    return true;
}

function transportSupportsAutomationContinuation(transportConfig: any, requestedContinuation: string | undefined): boolean {
    if (!transportConfig) return false;
    if (!requestedContinuation || requestedContinuation === 'single') {
        return true;
    }

    const supportedContinuations = getSupportedAutomationContinuations(transportConfig);
    if (supportedContinuations.length > 0) {
        return supportedContinuations.includes(requestedContinuation);
    }

    return false;
}

function transportSupportsAutomationPolicy(
    protocol: 'cli' | 'acp',
    transportConfig: any,
    requestedMode: string | undefined,
    requestedContinuation: string | undefined,
): boolean {
    return transportSupportsAutomationMode(protocol, transportConfig, requestedMode)
        && transportSupportsAutomationContinuation(transportConfig, requestedContinuation);
}

function hasRequestedAutomationPolicy(engineConfig: any): boolean {
    return !!engineConfig?.automation && typeof engineConfig.automation === 'object';
}

function describeRequestedAutomationPolicy(requestedMode: string | undefined, requestedContinuation: string | undefined): string {
    const mode = requestedMode || 'interactive';
    const continuation = requestedContinuation || 'single';
    return `mode='${mode}', continuation='${continuation}'`;
}

function getRequestedAutomationExplanation(engineConfig: any): EngineAutomationExplanation {
    const normalized = normalizeAutomationPolicy(engineConfig?.automation);
    return {
        declared: hasRequestedAutomationPolicy(engineConfig),
        mode: normalized.mode,
        continuation: normalized.continuation,
        ...(typeof normalized.maxContinues === 'number' ? { maxContinues: normalized.maxContinues } : {}),
    };
}

function getConfiguredTransportProtocols(engineConfig: any, preferredProtocol: 'cli' | 'acp'): Array<'cli' | 'acp'> {
    if (!engineConfig) return [];
    if (engineConfig.protocol !== 'auto') {
        const explicitProtocol = engineConfig.protocol === 'acp' ? 'acp' : 'cli';
        return getTransportConfig(engineConfig, explicitProtocol) ? [explicitProtocol] : [];
    }

    const candidates: Array<'cli' | 'acp'> = preferredProtocol === 'acp' ? ['acp', 'cli'] : ['cli', 'acp'];
    return candidates.filter(protocol => !!getTransportConfig(engineConfig, protocol));
}

function buildAutomationCompatibilityFixHint(engine: string, protocol: 'cli' | 'acp' | 'auto', requestedContinuation: string | undefined): string {
    if (requestedContinuation === 'autopilot') {
        if (!engine.toLowerCase().includes('copilot')) {
            return `Set automation.continuation to 'single' for engine '${engine}', or switch to a GitHub Copilot CLI engine if you need autopilot continuation.`;
        }
        if (protocol === 'acp') {
            return `Set protocol to 'cli' or 'auto' for engine '${engine}', or change automation.continuation to 'single'.`;
        }
    }
    return `Adjust automation.mode / automation.continuation or update the declared transport capabilities in available-agents.json.`;
}

function buildTransportCompatibilityReason(
    protocol: 'cli' | 'acp',
    transportConfig: any,
    requestedMode: string | undefined,
    requestedContinuation: string | undefined,
): string {
    if (!transportConfig) {
        return `protocol '${protocol}' is not configured`;
    }

    const reasons: string[] = [];
    if (requestedMode && !transportSupportsAutomationMode(protocol, transportConfig, requestedMode)) {
        reasons.push(`does not support automation.mode '${requestedMode}'`);
    }
    if (requestedContinuation && !transportSupportsAutomationContinuation(transportConfig, requestedContinuation)) {
        reasons.push(`does not support automation.continuation '${requestedContinuation}'`);
    }

    if (reasons.length === 0) {
        return requestedMode || requestedContinuation
            ? `satisfies ${describeRequestedAutomationPolicy(requestedMode, requestedContinuation)}`
            : 'available transport';
    }

    return reasons.join('; ');
}

function validateAutomationPolicyForProtocol(
    engine: string,
    protocol: 'cli' | 'acp' | 'auto',
    engineConfig: any,
    requestedMode: string | undefined,
    requestedContinuation: string | undefined,
): void {
    if (!engineConfig || !hasRequestedAutomationPolicy(engineConfig)) {
        return;
    }

    const preferredProtocol: 'cli' | 'acp' = engineConfig.preferred_protocol === 'cli' ? 'cli' : 'acp';
    const configuredProtocols = getConfiguredTransportProtocols(engineConfig, preferredProtocol);
    const matchingProtocols = configuredProtocols.filter(candidate =>
        transportSupportsAutomationPolicy(candidate, getTransportConfig(engineConfig, candidate), requestedMode, requestedContinuation)
    );

    if (protocol === 'auto') {
        if (matchingProtocols.length > 0) {
            return;
        }
        if (configuredProtocols.length === 0) {
            return;
        }

        throw new Error(
            `[Config] Invalid automation policy: engine '${engine}' cannot satisfy ${describeRequestedAutomationPolicy(requestedMode, requestedContinuation)} ` +
            `with any configured transport (${configuredProtocols.join(', ')}). Suggested fix: ${buildAutomationCompatibilityFixHint(engine, protocol, requestedContinuation)}`
        );
    }

    if (matchingProtocols.includes(protocol)) {
        return;
    }

    throw new Error(
        `[Config] Invalid automation policy: engine '${engine}' protocol '${protocol}' cannot satisfy ${describeRequestedAutomationPolicy(requestedMode, requestedContinuation)}. ` +
        `Compatible configured transport(s): ${matchingProtocols.length > 0 ? matchingProtocols.join(', ') : 'none'}. Suggested fix: ${buildAutomationCompatibilityFixHint(engine, protocol, requestedContinuation)}`
    );
}

function resolveProtocolFromEngineConfig(engine: string, engineConfig: any): 'cli' | 'acp' {
    if (!engineConfig) {
        return getDefaultProtocolForEngine(engine);
    }
    const requestedMode = getRequestedAutomationMode(engineConfig);
    const requestedContinuation = getRequestedAutomationContinuation(engineConfig);

    if (engineConfig.protocol !== 'auto') {
        const explicitProtocol = getConfiguredProtocol(engine, engineConfig) === 'acp' ? 'acp' : 'cli';
        validateAutomationPolicyForProtocol(engine, explicitProtocol, engineConfig, requestedMode, requestedContinuation);
        return explicitProtocol;
    }

    const preferredProtocol = getPreferredProtocol(engineConfig);
    validateAutomationPolicyForProtocol(engine, 'auto', engineConfig, requestedMode, requestedContinuation);
    const candidates: Array<'cli' | 'acp'> = preferredProtocol === 'acp' ? ['acp', 'cli'] : ['cli', 'acp'];

    for (const protocol of candidates) {
        if (transportSupportsAutomationPolicy(protocol, getTransportConfig(engineConfig, protocol), requestedMode, requestedContinuation)) {
            return protocol;
        }
    }

    return candidates.find(protocol => !!getTransportConfig(engineConfig, protocol)) || preferredProtocol;
}

export function loadEngineHeartbeatTimeout(workspacePath: string, engine: string): number | null {
    try {
        const engineConfig = getEngineConfig(engine, workspacePath);
        const protocol = resolveProtocolFromEngineConfig(engine, engineConfig);
        const heartbeatMs = getTransportConfig(engineConfig, protocol)?.timeout?.heartbeat_ms ?? engineConfig?.timeout?.heartbeat_ms;
        if (typeof heartbeatMs === 'number') return heartbeatMs;
    } catch (e: any) {
        console.error(`[Config] Warning: failed to read engine timeout for '${engine}': ${e.message}`);
    }
    return null;
}

export function loadEngineActivityTimeout(workspacePath: string, engine: string): number {
    try {
        const engineConfig = getEngineConfig(engine, workspacePath);
        const protocol = resolveProtocolFromEngineConfig(engine, engineConfig);
        const activityMs = getTransportConfig(engineConfig, protocol)?.timeout?.activity_ms ?? engineConfig?.timeout?.activity_ms;
        if (typeof activityMs === 'number') return activityMs;
    } catch (e: any) {
        console.error(`[Config] Warning: failed to read engine activity timeout for '${engine}': ${e.message}`);
    }
    return 0;
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
    const t2Dir = resolveOptimusPath(workspacePath, 'roles');
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

    const existingTemplate = loadBestRoleTemplate(workspacePath, safeRole);
    if (existingTemplate) {
        const existing = existingTemplate.content;
        const existingFm = { frontmatter: existingTemplate.frontmatter, body: existingTemplate.body };

        if (existingTemplate.path !== t2Path || existingTemplate.content !== existingTemplate.rawContent) {
            fs.writeFileSync(t2Path, existing, 'utf8');
            console.error(`[T2 Guard] Canonicalized role '${safeRole}' template from ${path.relative(workspacePath, existingTemplate.path)} to .optimus/roles/${safeRole}.md`);
        }

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
                registerRole(workspacePath, safeRole, desc);
                return t2Path;
            }
        } catch (e: any) { console.error(`[Precipitation] Warning: failed to process plugin template: ${e.message}`); }
    }

    // No plugin template found — check if Master provided a meaningful description
    const hasExplicitDescription = !!masterInfo?.description && masterInfo.description.trim().length > 0;

    if (!hasExplicitDescription) {
        // If a T2 already exists (even thin), don't reject — use what we have.
        // Only reject when there's truly NO T2 and no description to create one.
        if (fs.existsSync(t2Path)) {
            console.error(`[T2 Guard] No role_description provided for '${safeRole}', but existing T2 found (thin). Continuing with existing template.`);
            return t2Path;
        }
        // No T2 exists AND no description — reject the delegation.
        throw new Error(
            `Missing role_description for new role '${safeRole}'. ` +
            `No existing T2 role template found at .optimus/roles/${safeRole}.md. ` +
            `Please re-call delegate_task with a role_description parameter describing this role's expertise, ` +
            `or use role-creator to pre-create the role before delegation.`
        );
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
        registerRole(workspacePath, safeRole, desc);
        return t2Path;
    }

    // Normal path: use role-creator for rich role generation
    try {
        await generateRichT2Role(workspacePath, role, validatedEng, validatedMod || undefined, desc, t2Path, currentDepthLocal);
        console.error(`[Precipitation] T3 role '${safeRole}' promoted to T2 (rich, via role-creator) at ${t2Path}`);
        registerRole(workspacePath, safeRole, desc);
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
    const skillPath = resolveOptimusPath(workspacePath, 'skills', 'role-creator', 'SKILL.md');
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
    const extracted = extractBestFrontmatterDocument(response, safeRole, t2Path, t2Path);
    const roleContent = extracted?.content ?? response;

    // 4. Parse the response — look for frontmatter start
    const fmStart = roleContent.indexOf('---');
    if (fmStart === -1) {
        throw new Error('role-creator response did not contain valid frontmatter (no --- found)');
    }
    const content = roleContent.slice(fmStart).trim();

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
        return resolveOptimusPath(this.workspacePath, 'agents');
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

export function parseRoleSpec(roleArg: string, workspacePath?: string): { role: string, engine?: string, model?: string } {
    const segments = path.basename(roleArg).split('_').filter(Boolean);
    const knownEngines = new Set([
        ...getConfiguredEngineNames(workspacePath),
        'claude-code',
        'copilot-cli',
        'github-copilot',
        'acp',
    ]);
    const engineIndex = segments.findIndex(segment => knownEngines.has(segment));

    if (engineIndex === -1) {
        return { role: path.basename(roleArg) };
    }

    const role = segments.slice(0, engineIndex).join('_') || path.basename(roleArg);
    const engine = segments[engineIndex];
    const model = segments.slice(engineIndex + 1).join('_');
    return { role, engine, model };
}

export function getEngineProtocol(engine: string, workspacePath?: string): 'cli' | 'acp' {
    return resolveProtocolFromEngineConfig(engine, getEngineConfig(engine, workspacePath));
}

export function resolveCliAdapterKind(engine: string, workspacePath?: string): 'github-copilot' | 'claude-code' {
    const engineConfig = getEngineConfig(engine, workspacePath);
    const protocol = resolveProtocolFromEngineConfig(engine, engineConfig);
    const transportConfig = getTransportConfig(engineConfig, protocol);
    const fingerprint = [engine, transportConfig?.path, ...(transportConfig?.args || [])]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ')
        .toLowerCase();

    return fingerprint.includes('copilot') ? 'github-copilot' : 'claude-code';
}

function buildResolvedTransportForProtocol(
    engine: string,
    protocol: 'cli' | 'acp',
    transportConfig: any,
    model?: string,
): { protocol: 'cli' | 'acp'; executable?: string; args: string[] } {
    if (protocol !== 'acp') {
        return {
            protocol,
            executable: transportConfig?.path,
            args: Array.isArray(transportConfig?.args) ? [...transportConfig.args] : [],
        };
    }

    let executable = transportConfig?.path || 'copilot';
    let args: string[] = transportConfig?.args ? [...transportConfig.args] : getDocumentedDefaultAcpArgs(engine);

    if (executable === 'auto') {
        const discovered = discoverAcpCli(engine);
        if (discovered) {
            executable = discovered.executable;
            args = [...discovered.args, ...args];
        } else {
            throw new Error(
                `[Engine] Auto-discovery failed for '${engine}': Could not find CLI in VS Code extensions. ` +
                `Install the Qwen Code extension in VS Code, or set an explicit 'path' in available-agents.json.`
            );
        }
    } else if (!transportConfig?.args && transportConfig?.path && executable !== 'node') {
        const parts = transportConfig.path.split(/\s+/);
        executable = parts[0];
        const pathArgs = parts.slice(1);
        if (pathArgs.length > 0) {
            args = pathArgs;
        }
    }

    if (transportConfig?.cli_flags && model) {
        args.push(transportConfig.cli_flags, model);
    }

    return { protocol, executable, args };
}

function buildEngineSelectionReason(
    engine: string,
    engineConfig: any,
    selectedProtocol: 'cli' | 'acp',
    requestedMode: string | undefined,
    requestedContinuation: string | undefined,
    candidates: EngineTransportExplanation[],
): string {
    const configuredProtocol = getConfiguredProtocol(engine, engineConfig);
    if (configuredProtocol !== 'auto') {
        return `Protocol explicitly pinned to '${selectedProtocol}' and satisfies ${describeRequestedAutomationPolicy(requestedMode, requestedContinuation)}.`;
    }

    const preferredProtocol = getPreferredProtocol(engineConfig);
    if (selectedProtocol === preferredProtocol) {
        return `Selected preferred protocol '${selectedProtocol}' because it satisfies ${describeRequestedAutomationPolicy(requestedMode, requestedContinuation)}.`;
    }

    const preferredCandidate = candidates.find(candidate => candidate.protocol === preferredProtocol);
    if (!preferredCandidate?.configured) {
        return `Selected '${selectedProtocol}' because preferred protocol '${preferredProtocol}' is not configured.`;
    }

    return `Selected '${selectedProtocol}' because preferred protocol '${preferredProtocol}' ${preferredCandidate.reason}.`;
}

export function explainEngineResolution(engine: string, workspacePath?: string, model?: string): EngineResolutionExplanation {
    const engineConfig = getEngineConfig(engine, workspacePath);
    if (!engineConfig) {
        return {
            engine,
            configuredProtocol: getDefaultProtocolForEngine(engine),
            preferredProtocol: 'acp',
            requestedAutomation: getRequestedAutomationExplanation(null),
            availableModels: [],
            selectedProtocol: null,
            selectedTransport: null,
            selectionReason: `Engine '${engine}' is not declared in available-agents.json.`,
            candidates: [],
            error: `[Config] Engine '${engine}' is not declared in available-agents.json. Suggested fix: add it under engines in .optimus/config/available-agents.json.`,
        };
    }

    const requestedAutomation = getRequestedAutomationExplanation(engineConfig);
    const requestedMode = getRequestedAutomationMode(engineConfig);
    const requestedContinuation = getRequestedAutomationContinuation(engineConfig);
    const configuredProtocol = getConfiguredProtocol(engine, engineConfig);
    const preferredProtocol = getPreferredProtocol(engineConfig);
    const candidateOrder: Array<'cli' | 'acp'> = configuredProtocol === 'auto'
        ? (preferredProtocol === 'acp' ? ['acp', 'cli'] : ['cli', 'acp']) as Array<'cli' | 'acp'>
        : [configuredProtocol, ...(configuredProtocol === 'acp' ? ['cli'] : ['acp'])] as Array<'cli' | 'acp'>;

    const candidates = candidateOrder.map((protocol): EngineTransportExplanation => {
        const transportConfig = getTransportConfig(engineConfig, protocol);
        const supportsRequestedMode = transportSupportsAutomationMode(protocol, transportConfig, requestedMode);
        const supportsRequestedContinuation = transportSupportsAutomationContinuation(transportConfig, requestedContinuation);
        const supportsRequestedPolicy = transportSupportsAutomationPolicy(protocol, transportConfig, requestedMode, requestedContinuation);
        let preview: { protocol: 'cli' | 'acp'; executable?: string; args: string[] } = {
            protocol,
            executable: transportConfig?.path,
            args: Array.isArray(transportConfig?.args) ? [...transportConfig.args] : protocol === 'acp' && transportConfig ? getDocumentedDefaultAcpArgs(engine) : []
        };

        if (transportConfig) {
            try {
                preview = buildResolvedTransportForProtocol(engine, protocol, transportConfig, model);
            } catch {
                // Keep the raw preview for explain output; selected transport resolution will surface the real error.
            }
        }

        return {
            protocol,
            configured: !!transportConfig,
            executable: preview.executable,
            args: preview.args,
            supportsRequestedMode,
            supportsRequestedContinuation,
            supportsRequestedPolicy,
            capabilities: {
                automation_modes: getSupportedAutomationModes(transportConfig),
                automation_continuations: getSupportedAutomationContinuations(transportConfig),
            },
            reason: buildTransportCompatibilityReason(protocol, transportConfig, requestedMode, requestedContinuation),
        };
    });

    try {
        const selectedProtocol = resolveProtocolFromEngineConfig(engine, engineConfig);
        const selectedTransportConfig = getTransportConfig(engineConfig, selectedProtocol) || engineConfig;
        const selectedTransport = buildResolvedTransportForProtocol(engine, selectedProtocol, selectedTransportConfig, model);

        return {
            engine,
            configuredProtocol,
            preferredProtocol,
            requestedAutomation,
            availableModels: Array.isArray(engineConfig.available_models) ? [...engineConfig.available_models] : [],
            status: typeof engineConfig.status === 'string' ? engineConfig.status : undefined,
            selectedProtocol,
            selectedTransport,
            selectionReason: buildEngineSelectionReason(engine, engineConfig, selectedProtocol, requestedMode, requestedContinuation, candidates),
            candidates,
        };
    } catch (e: any) {
        const message = e instanceof Error ? e.message : String(e);
        return {
            engine,
            configuredProtocol,
            preferredProtocol,
            requestedAutomation,
            availableModels: Array.isArray(engineConfig.available_models) ? [...engineConfig.available_models] : [],
            status: typeof engineConfig.status === 'string' ? engineConfig.status : undefined,
            selectedProtocol: null,
            selectedTransport: null,
            selectionReason: message,
            candidates,
            error: message,
        };
    }
}

export function explainAvailableAgentsConfig(workspacePath?: string): Record<string, EngineResolutionExplanation> {
    const config = loadAvailableAgentsConfig(workspacePath);
    if (!config) {
        return {};
    }

    return Object.fromEntries(
        Object.keys(config.engines).map(engine => [engine, explainEngineResolution(engine, workspacePath)])
    );
}

export function getResolvedEngineTransport(engine: string, workspacePath?: string, model?: string): { protocol: 'cli' | 'acp'; executable?: string; args: string[] } {
    const engineConfig = getEngineConfig(engine, workspacePath);
    const protocol = resolveProtocolFromEngineConfig(engine, engineConfig);
    const transportConfig = getTransportConfig(engineConfig, protocol) || engineConfig;
    return buildResolvedTransportForProtocol(engine, protocol, transportConfig, model);
}

function getAdapterForEngine(engine: string, sessionId?: string, model?: string, workspacePath?: string): AgentAdapter {
    const engineConfig = getEngineConfig(engine, workspacePath);
    const transport = getResolvedEngineTransport(engine, workspacePath, model);
    const protocol = transport.protocol;
    const transportConfig = getTransportConfig(engineConfig, protocol) || engineConfig;

    if (protocol === 'acp') {
        if (transportConfig?.path === 'auto' && transport.executable && transport.executable !== 'auto') {
            const discoveredArgs = transport.args.slice(0, Math.max(transport.args.length - (transportConfig?.args?.length || 0), 0));
            console.error(`[Engine] Auto-discovered ${engine} CLI: ${transport.executable} ${discoveredArgs.join(' ')}`);
        }
        const activityMs = workspacePath ? loadEngineActivityTimeout(workspacePath, engine) : 0;
        // Use persistent process pool for warm ACP adapter reuse
        return AcpProcessPool.getInstance().getOrCreateAdapter(engine, transport.executable || 'copilot', transport.args, activityMs);
    }

    // CLI path — deprecated since v2.16.8. All engines should use protocol: "acp".
    console.error(`[Engine] ⚠️ DEPRECATED: CLI adapter for '${engine}'. Set protocol: "acp" in .optimus/config/available-agents.json. CLI adapters will be removed in a future version.`);
    const hasAutomationConfig = !!engineConfig?.automation && typeof engineConfig.automation === 'object';
    const automationPolicy = hasAutomationConfig ? normalizeAutomationPolicy(engineConfig.automation) : null;
    if (resolveCliAdapterKind(engine, workspacePath) === 'github-copilot') {
        return new GitHubCopilotAdapter(undefined, '🛸 GitHub Copilot', model || '', undefined, {
            autoApprove: automationPolicy ? automationPolicy.mode === 'auto-approve' : undefined,
            autopilot: automationPolicy ? automationPolicy.continuation === 'autopilot' : false,
            maxAutopilotContinues: automationPolicy?.maxContinues,
        });
    }

    return new ClaudeCodeAdapter(undefined, '🦖 Claude Code', model || '', undefined, {
        permissionMode: automationPolicy ? getClaudePermissionModeForPolicy(automationPolicy) : undefined,
    });
}

/**
 * Classify worker execution errors into agent-friendly messages with recovery guidance.
 */
function classifyWorkerError(role: string, engine: string, e: any): string {
    const msg = e instanceof Error ? e.message : String(e);
    const prefix = `Worker execution failed for role '${role}' on engine '${engine}'`;

    // Auth errors
    if (/auth_failed/i.test(msg) || /authentication required/i.test(msg) || /unauthorized/i.test(msg) || /No authentication/i.test(msg)) {
        return `${prefix}: auth_failed — ${msg}. Fix: for Copilot run \`gh auth login\` (uses gh CLI auth). For Claude run \`claude login\` or set ANTHROPIC_API_KEY.`;
    }

    // Rate limit
    if (/rate_limit/i.test(msg) || /429/i.test(msg) || /too many requests/i.test(msg) || /quota/i.test(msg)) {
        return `${prefix}: rate_limit — ${msg}. Fix: wait and retry. Use runtime_policy.retries for automatic retry.`;
    }

    // Timeout
    if (/task_timeout/i.test(msg) || /activity timeout/i.test(msg) || /heartbeat/i.test(msg)) {
        return `${prefix}: task_timeout — ${msg}`;
    }

    // Process crash
    if (/acp_process_crashed/i.test(msg) || /exited unexpectedly/i.test(msg) || /SIGKILL/i.test(msg)) {
        return `${prefix}: acp_process_crashed — ${msg}. The warm pool will auto-recover. Retry the task.`;
    }

    // Model errors
    if (/invalid_model/i.test(msg) || /invalid model/i.test(msg)) {
        return `${prefix}: invalid_model — ${msg}`;
    }

    // Default
    return `${prefix}: ${msg}`;
}

/**
 * Executes a single task delegation synchronously.
 */
export async function delegateTaskSingle(roleArg: string, taskPath: string, outputPath: string, _fallbackSessionId: string, workspacePath: string, contextFiles?: string[], masterInfo?: MasterRoleInfo, parentDepth?: number, parentIssueNumber?: number, autoIssueNumber?: number, agentId?: string): Promise<string> {
    const parsedRole = parseRoleSpec(roleArg, workspacePath);
    const role = sanitizeRoleName(parsedRole.role);

    const currentDepth = parentDepth !== undefined ? parentDepth : parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || '0', 10);
    const childDepth = currentDepth + 1;
    console.error(`[Orchestrator] Delegation depth: ${childDepth}/${MAX_DELEGATION_DEPTH}`);
    if (childDepth >= MAX_DELEGATION_DEPTH) {
        console.error(`[Orchestrator] Max delegation depth reached — MCP config will be stripped`);
    }

    // Auto-migrate legacy folder `.optimus/personas` to `.optimus/agents`
    const legacyT1Dir = resolveOptimusPath(workspacePath, 'personas');
    const t1Dir = resolveOptimusPath(workspacePath, 'agents');
    if (fs.existsSync(legacyT1Dir) && !fs.existsSync(t1Dir)) {
        try { fs.renameSync(legacyT1Dir, t1Dir); } catch (e: any) { console.error(`[Orchestrator] Warning: operation failed: ${e.message}`); }
    }
    
    const t2Dir = resolveOptimusPath(workspacePath, 'roles');
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
    let storedEngineForSession: string | undefined = undefined;
    let storedProtocolForSession: string | undefined = undefined;

    let t1Content = '';
    let t1Path = '';  // Will be resolved dynamically based on role+engine match
    let shouldLocalize = false;
    let resolvedTier = 'T3 (Zero-Shot Outsource)';
    let personaProof = 'No dedicated role template found in T2 or T1. Using T3 generic prompt.';

    // --- T1 Lookup: ONLY when agent_id is specified (explicit session reuse) ---
    // Without agent_id, each task gets a fresh T1 instance to enable parallel execution.
    if (agentId && fs.existsSync(t1Dir)) {
        // Exact T1 lookup by agent_id (e.g., 'product-manager_1e5b9723')
        const exactPath = path.join(t1Dir, `${agentId}.md`);
        if (fs.existsSync(exactPath)) {
            t1Path = exactPath;
            t1Content = fs.readFileSync(exactPath, 'utf8');
            resolvedTier = `T1 (Agent Instance -> ${agentId}.md, via agent_id)`;
            personaProof = `Resumed specific agent instance: ${t1Path}`;
            console.error(`[Orchestrator] agent_id="${agentId}" resolved to T1 instance: ${exactPath}`);
        } else {
            console.error(`[Orchestrator] agent_id="${agentId}" not found at ${exactPath} — falling back to T2 role template`);
        }
    }
    // Without agent_id: skip T1 glob lookup — go straight to T2 template for a fresh session

    const bestRoleTemplate = loadBestRoleTemplate(workspacePath, role);
    if (!t1Content && bestRoleTemplate) {
        t1Content = bestRoleTemplate.content;
        shouldLocalize = true;
        const relativeTemplatePath = path.relative(workspacePath, bestRoleTemplate.path).replace(/\\/g, '/');
        resolvedTier = `T2 (Role Template -> ${relativeTemplatePath})`;
        personaProof = `Found globally promoted Role template: ${bestRoleTemplate.path}`;
    }

    if (t1Content) {
        const fm = parseFrontmatter(t1Content);
        // Frontmatter values are defaults; caller-supplied masterInfo takes priority
        storedEngineForSession = fm.frontmatter.engine;
        storedProtocolForSession = fm.frontmatter.adapter_protocol;
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
        try {
            const config = loadAvailableAgentsConfig(workspacePath);
            if (config) {
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
        try {
            const engineConfig = getEngineConfig(activeEngine, workspacePath);
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
        } catch (e: any) {
            if (e.message?.includes('Model Pre-Flight Failed')) throw e;
        }
    }

    // --- Engine Health Check & Fallback ---
    let wasFallback = false;
    const engineBeforeFallback = activeEngine;
    if (activeModel) {
        const resolved = resolveHealthyModel(workspacePath, activeEngine, activeModel);
        if (resolved.engine !== activeEngine || resolved.model !== activeModel) {
            console.error(`[EngineHealth] Fallback: ${activeEngine}/${activeModel} → ${resolved.engine}/${resolved.model}`);
            activeEngine = resolved.engine;
            activeModel = resolved.model;
            wasFallback = true;
        }
    }
    // If the engine changed during fallback, clear any stored session ID — it belongs to the old engine.
    if (wasFallback && activeEngine !== engineBeforeFallback && activeSessionId) {
        console.error(
            `[Orchestrator] Session cleared for ${role}: engine changed from ${engineBeforeFallback} to ${activeEngine} during health fallback. Starting a fresh session.`
        );
        activeSessionId = undefined;
    }

    const activeProtocol = getEngineProtocol(activeEngine, workspacePath);
    if (activeSessionId) {
        const engineChanged = !!storedEngineForSession && storedEngineForSession !== activeEngine;
        const protocolChanged = !!storedProtocolForSession && storedProtocolForSession !== activeProtocol;
        const legacyUnknownProtocol = activeProtocol === 'acp' && !storedProtocolForSession;

        if (engineChanged || protocolChanged || legacyUnknownProtocol) {
            console.error(
                `[Orchestrator] Session reuse disabled for ${role}: stored engine/protocol ` +
                `${storedEngineForSession || 'unknown'}/${storedProtocolForSession || 'unknown'} ` +
                `is incompatible with active ${activeEngine}/${activeProtocol}. Starting a fresh session.`
            );
            activeSessionId = undefined;
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

    const adapter = getAdapterForEngine(activeEngine, activeSessionId, activeModel, workspacePath);

    // Detect if this engine uses ACP protocol (lean prompt mode)
    const isAcpEngine = activeProtocol === 'acp';

    console.error(`[Orchestrator] Resolving Identity for ${role}...`);
    console.error(`[Orchestrator] Selected Stratum: ${resolvedTier}`);
    console.error(`[Orchestrator] Engine: ${activeEngine}, Session: ${activeSessionId || 'New/Ephemeral'}, ACP: ${isAcpEngine}`);

    // T2→T1 instantiation happens AFTER task execution (when session_id is captured).

    const rawTaskText = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8') : taskPath;
    const { sanitized: sanitizedTaskText } = sanitizeExternalContent(rawTaskText, `task:${role}`);
    // Normalize Windows backslash paths to forward slashes within the task text.
    // LLMs often fail to escape backslashes in JSON tool call arguments, causing
    // paths like C:\Users\foo to become C:Usersfoo when the JSON parser strips them.
    // We replace the known workspace path and common .optimus\ relative patterns.
    let taskText = sanitizedTaskText;
    if (process.platform === 'win32') {
        // Replace the absolute workspace path with its forward-slash form
        const bsWorkspace = workspacePath.replace(/\//g, '\\');
        const fsWorkspace = normalizePathForAgent(workspacePath);
        taskText = taskText.split(bsWorkspace).join(fsWorkspace);
        // Also normalize any remaining backslash-separated path segments that look like
        // file paths (drive-letter prefix or .optimus\ or src\ etc.)
        taskText = taskText.replace(/([A-Za-z]):\\(?=[A-Za-z])/g, '$1:/');
    }

    let personaContext = "";
    if (t1Content) {
        personaContext = parseFrontmatter(t1Content).body.trim();
    } else {
        const formattedRole = role
            .split(/[-_]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
            
        personaContext = `You are a ${formattedRole} expert operating within the Optimus Spartan Swarm. Your purpose is to fulfill tasks autonomously within your specialized domain of expertise.\nAs a dynamically provisioned "T3" agent, apply industry best practices, solve complex problems, and deliver professional-grade results associated with your role.`;
        
        const systemInstructionsPath = resolveOptimusPath(workspacePath, 'config', 'system-instructions.md');
        if (fs.existsSync(systemInstructionsPath)) {
            try {
                const systemInstructions = fs.readFileSync(systemInstructionsPath, 'utf8');
                personaContext += `\n\n--- START WORKSPACE SYSTEM INSTRUCTIONS ---\n${systemInstructions.trim()}\n--- END WORKSPACE SYSTEM INSTRUCTIONS ---`;
            } catch (e: any) { console.error(`[Orchestrator] Warning: failed to read system-instructions.md: ${e.message}`); }
        }
    }

    // Load project memory for injection (after persona, before task)
    const memoryFile = resolveOptimusPath(workspacePath, 'memory', 'continuous-memory.md');
    migrateMemoryFile(memoryFile);
    const memoryContent = loadFilteredMemory(workspacePath, role);
    const memorySection = memoryContent
        ? `\n\n--- START PROJECT MEMORY ---\nThe following are verified lessons and decisions from this project's history.\nApply them to avoid repeating past mistakes.\n\n${memoryContent}\n--- END PROJECT MEMORY ---`
        : '';

    // Load user memory for injection (after project memory)
    const userMemoryContent = loadUserMemory(2000);
    const userMemorySection = userMemoryContent
        ? `\n\n--- START USER MEMORY (REFERENCE ONLY) ---\nThe following are personal preferences from this user.\nThese apply across projects but may be overridden by project-specific conventions.\n\n${userMemoryContent}\n--- END USER MEMORY ---`
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
                contextContent += `(File not found at ${normalizePathForAgent(absolutePath)})\n`;
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
${memorySection}${userMemorySection}
Goal: Execute the following task.
System Note: ${personaProof}
${trackingIssueHeader}
If you need additional project context beyond what was provided:
1. Call \`list_knowledge\` to discover available specs, proposals, and memory entries
2. Read only the artifacts directly relevant to your task
3. Do not read everything — prioritize by topic match and recency

Task Description:
${taskText}${contextContent}${skillContent ? `\n\n=== EQUIPPED SKILLS ===\nThe following skills have been loaded for you to reference and follow:\n${skillContent}\n=== END SKILLS ===` : ''}

CRITICAL: Your output MUST be written to this EXACT file: ${normalizePathForAgent(outputPath)}
Please provide your complete execution result below.`;

    console.error(`[Orchestrator] Prompt size: ${basePrompt.length} chars (ACP lean: ${isAcpEngine})`);
    const isT3 = resolvedTier.startsWith('T3');

    // Lock by agent_id (serial for same session) or ephemeral key (parallel for independent tasks)
    // This allows multiple tasks for the same ROLE to run in parallel when they don't share a session.
    const lockKey = agentId || `${role}_ephemeral_${crypto.randomUUID().slice(0, 8)}`;
    const lockManager = getLockManager(workspacePath);
    await lockManager.acquireLock(lockKey);
    try {
        await ConcurrencyGovernor.acquire();

        // --- Pre-Flight: Ensure T2 role template exists BEFORE creating T1 ---
        // Logical order: T2 (role definition) → T1 (instance). Never create T1 without T2.
        await ensureT2Role(workspacePath, role, activeEngine, activeModel, masterInfo, currentDepth);

        // --- Pre-Flight: Create T1 instance placeholder from T2 template ---
        // session_id is unknown until after execution, so use a temp name.
        // Post-execution will rename to {role}_{session_id_prefix}.md
        const agentsDir = resolveOptimusPath(workspacePath, 'agents');
        if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });

        const tempId = Math.random().toString(36).slice(2, 10);
        const t1TempPath = t1Path || path.join(agentsDir, `${role}_pending_${tempId}.md`);
        const t2Exists = fs.existsSync(t2Path);
        if (!t1Path && t2Exists) {
            // T2 exists — create T1 instance from T2 template
            const t1Template = fs.readFileSync(t2Path, 'utf8');
            const t1Instance = updateFrontmatter(t1Template, {
                role: role,
                base_tier: 'T1',
                engine: activeEngine,
                adapter_protocol: activeProtocol,
                ...(activeModel ? { model: activeModel } : {}),
                session_id: '',
                status: 'running',
                created_at: new Date().toISOString()
            });
            fs.writeFileSync(t1TempPath, t1Instance, 'utf8');
            console.error(`[Orchestrator] T2→T1: Created temp agent placeholder '${role}' at ${path.basename(t1TempPath)}`);
        } else if (!t1Path) {
            // No T2 — running as T3 zero-shot, skip T1 creation
            console.error(`[Orchestrator] No T2 for '${role}' — running as T3 zero-shot, no T1 instance created.`);
        }

        const extraEnv: Record<string, string> = {
            OPTIMUS_DELEGATION_DEPTH: String(childDepth),
            OPTIMUS_CURRENT_ROLE: role,
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
        // Build ACP session options (autopilot mode, model selection)
        const engineConfig = getEngineConfig(activeEngine, workspacePath);
        const hasAutomation = !!engineConfig?.automation && typeof engineConfig.automation === 'object';
        const automationPolicy = hasAutomation ? normalizeAutomationPolicy(engineConfig.automation) : null;
        const acpOptions = activeProtocol === 'acp' ? {
            model: activeModel || undefined,
            autopilot: automationPolicy ? automationPolicy.continuation === 'autopilot' : false,
            maxContinues: automationPolicy?.maxContinues,
        } : undefined;

        const response = await adapter.invoke(basePrompt, activeMode, activeSessionId, undefined, extraEnv, acpOptions);

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
            /^Worker execution failed/m,
        ];
        const matchedError = errorPatterns.find(p => p.test(firstLines));
        // Only fail if error pattern matched AND there's no meaningful non-log output
        if (matchedError && nonLogLines.length < 100) {
            // Clean up temp T1 — don't leave zombies
            const tempFile = t1Path || resolveOptimusPath(workspacePath, 'agents', `${role}_pending_${tempId}.md`);
            if (fs.existsSync(tempFile) && tempFile.includes('pending_')) {
                try { fs.unlinkSync(tempFile); } catch (e: any) { console.error(`[Orchestrator] Warning: operation failed: ${e.message}`); }
            }
            throw new Error(
                `⚠️ **Delegation Failed (Engine Error)**: Role \`${role}\` on engine \`${activeEngine}\` returned an error.\n\n` +
                `**Error output**:\n\`\`\`\n${firstLines.trim()}\n\`\`\`\n\n` +
                `**Suggested actions**:\n` +
                `- Re-delegate with a different engine (e.g., \`claude-code\` instead of \`github-copilot\`)\n` +
                `- Check if the model name is valid for this engine\n` +
                `- Verify engine authentication (e.g., \`gh auth login\` for Copilot, \`claude login\` for Claude)`
            );
        }

        // --- Post-Execution: Backfill session_id and rename T1 to final name ---
        const currentT1 = fs.existsSync(t1TempPath) ? t1TempPath : t1Path;
        if (currentT1 && fs.existsSync(currentT1)) {
            const currentStr = fs.readFileSync(currentT1, 'utf8');
            const updates: Record<string, string> = {
                engine: activeEngine,
                adapter_protocol: activeProtocol,
                status: 'idle',
                last_invoked: new Date().toISOString()
            };
            if (activeModel) {
                updates.model = activeModel;
            }
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

            // Backfill agent_id to task manifest for meta-cron session persistence
            const agentId2 = `${role}_${sessionPrefix}`;
            if (_fallbackSessionId.startsWith('async_')) {
                const taskId = _fallbackSessionId.replace('async_', '');
                TaskManifestManager.updateTask(workspacePath, taskId, {
                    agent_id: agentId2,
                    resolved_engine: activeEngine,
                    resolved_model: activeModel,
                    session_id: newSessionId || _fallbackSessionId
                });
            }
        }

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Strip tool-call traces from output before writing to artifact file.
        // PersistentAgentAdapter.combineStructuredDisplay() merges processText (traces)
        // with assistantText (content). For artifact files consumed by other agents,
        // only the clean content should be persisted.
        const cleanResponse = stripTraceLines(response);
        fs.writeFileSync(outputPath, cleanResponse, 'utf8');

        // Track T3 success AFTER we know execution succeeded
        if (isT3) {
            trackT3Usage(workspacePath, role, true, activeEngine, activeModel);
        }
        // Track engine+model health on success
        if (activeModel) {
            trackEngineHealth(workspacePath, activeEngine, activeModel, true);
        }

        return `✅ **Task Delegation Successful**\n\n**Agent Identity Resolved**: ${resolvedTier}\n**Engine**: ${activeEngine}\n**Session ID**: ${adapter.lastSessionId || 'Ephemeral'}\n\n**System Note**: ${personaProof}\n\nAgent has finished execution. Check standard output at \`${normalizePathForAgent(outputPath)}\`.`;
    } catch (e: any) {
        // Track T3 failures too
        if (isT3) {
            trackT3Usage(workspacePath, role, false, activeEngine, activeModel);
        }
        // Track engine+model health on failure
        if (activeModel) {
            trackEngineHealth(workspacePath, activeEngine, activeModel, false);
        }
        // Check quarantine threshold: 3+ consecutive failures with 0 successes
        // Don't quarantine role if failure was due to engine/model health (wasFallback)
        const log = loadT3UsageLog(workspacePath);
        const entry = log[role];
        if (entry && entry.consecutive_failures >= 3 && entry.successes === 0 && !wasFallback) {
            const t2RolePath = resolveOptimusPath(workspacePath, 'roles', `${sanitizeRoleName(role)}.md`);
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
        throw new Error(classifyWorkerError(role, activeEngine, e));
    } finally {
        ConcurrencyGovernor.release();
        lockManager.releaseLock(lockKey);
    }
}

/**
 * Spawns a single expert worker process for council review.
 */
export async function spawnWorker(role: string, proposalPath: string, outputPath: string, sessionId: string, workspacePath: string, parentDepth?: number, parentIssueNumber?: number, roleDescription?: string, diversityEngine?: string, diversityModel?: string): Promise<string> {
    try {
        const engineLabel = diversityEngine ? ` [engine=${diversityEngine}, model=${diversityModel}]` : '';
        console.error(`[Spawner] Launching Real Worker ${role}${engineLabel} for council review`);
        const masterInfo: MasterRoleInfo | undefined = {
            ...(roleDescription ? { description: roleDescription } : {}),
            ...(diversityEngine ? { engine: diversityEngine } : {}),
            ...(diversityModel ? { model: diversityModel } : {})
        };
        const effectiveMasterInfo = Object.keys(masterInfo).length > 0 ? masterInfo : undefined;
        return await delegateTaskSingle(role, `Please read the architectural PROPOSAL located at: ${proposalPath}.
Provide your expert critique from the perspective of your role (${role}). Identify architectural bottlenecks, DX friction, security risks, or asynchronous race conditions. Conclude with a recommendation: Reject, Accept, or Hybrid.`, outputPath, sessionId, workspacePath, undefined, effectiveMasterInfo, parentDepth, parentIssueNumber);
    } catch (err: any) {
        console.error(`[Spawner] Worker ${role} failed to start:`, err);
        return `❌ ${role}: exited with errors (${err.message}).`;
    }
}

/**
 * Three-state readiness classification for a configured engine:model combo.
 *
 *   confirmed_healthy — has recorded successes (status: healthy or degraded)
 *   unverified        — no health history (never been invoked)
 *   unhealthy         — recorded failures within TTL
 */
type ComboReadiness = 'confirmed_healthy' | 'unverified' | 'unhealthy';

function classifyComboReadiness(entry: EngineHealthEntry | undefined, now: number): ComboReadiness {
    if (!entry) return 'unverified';
    if (entry.status === 'unhealthy' && (now - new Date(entry.last_failure).getTime()) < ENGINE_HEALTH_TTL_MS) {
        return 'unhealthy';
    }
    // Has at least one recorded success → confirmed healthy
    if (entry.successes > 0) return 'confirmed_healthy';
    return 'unverified';
}

/**
 * Static validation: reject combos that cannot possibly work before any health
 * check. This catches "phantom capacity" from malformed config entries.
 *
 * Rules:
 *   - Engine path must be non-empty (checked via available-agents.json)
 *   - If an engine lists available_models, each model string must be non-empty
 */
function isStaticallyValid(eng: string, mdl: string, configPath: string): boolean {
    try {
        const config = readAvailableAgentsConfigFile(configPath);
        if (!config) return false;
        const engineConfig = config.engines?.[eng];
        if (!engineConfig) return false;
        const protocol = resolveProtocolFromEngineConfig(eng, engineConfig);
        const transportConfig = getTransportConfig(engineConfig, protocol) || engineConfig;
        // An engine with missing/non-string/blank path is not runnable.
        const enginePath = transportConfig?.path;
        if (enginePath !== 'auto' && (typeof enginePath !== 'string' || enginePath.trim() === '')) return false;
        // If the engine declares concrete models, each combo model must be a non-empty string.
        if (Array.isArray(engineConfig.available_models) && engineConfig.available_models.length > 0) {
            if (typeof mdl !== 'string' || mdl.trim() === '') return false;
        }
    } catch {
        // Can't read config — treat as valid (permissive fallback)
    }
    return true;
}

/**
 * Compute cross-model diversity assignments for council roles.
 * Greedy round-robin: distribute roles across runnable engine:model combos.
 * Handles edge cases: 1 engine, 1 model, or more roles than combos.
 *
 * Combo classification (three-state):
 *   confirmed_healthy — prior successful invocations recorded
 *   unverified        — no health history but passes static validation
 *   unhealthy         — recorded failures within TTL; excluded from pool
 *
 * Pool priority: confirmed_healthy first, then unverified as fallback.
 * Logged distinctly: configured pool, validated pool, actual assigned pool.
 */
function computeDiversityAssignments(roles: string[], workspacePath: string): Array<{ engine?: string; model?: string }> {
    const health = loadEngineHealth(workspacePath);
    const { engines, models } = loadValidEnginesAndModels(workspacePath);
    const configPath = resolveOptimusPath(workspacePath, 'config', 'available-agents.json');

    if (engines.length === 0) {
        // No config — let each role use its default
        console.error('[Council Diversity] No available-agents.json config — each role will use engine defaults');
        return roles.map(() => ({}));
    }

    const now = Date.now();

    // Enumerate all configured combos
    const configuredPool: Array<{ engine: string; model: string }> = [];
    for (const eng of engines) {
        const engineModels = models[eng] || [];
        if (engineModels.length === 0) {
            configuredPool.push({ engine: eng, model: '' });
        } else {
            for (const mdl of engineModels) {
                configuredPool.push({ engine: eng, model: mdl });
            }
        }
    }
    console.error(`[Council Diversity] Configured pool (${configuredPool.length}): ${configuredPool.map(c => `${c.engine}:${c.model || 'default'}`).join(', ')}`);

    // Classify each configured combo
    const confirmedHealthy: Array<{ engine: string; model: string }> = [];
    const unverified: Array<{ engine: string; model: string }> = [];
    let unhealthyCount = 0;
    let staticRejectedCount = 0;

    for (const combo of configuredPool) {
        // Static validation first — reject phantom combos
        if (!isStaticallyValid(combo.engine, combo.model, configPath)) {
            staticRejectedCount++;
            console.error(`[Council Diversity] Static validation rejected: ${combo.engine}:${combo.model || 'default'} (empty path or empty model string)`);
            continue;
        }
        const key = combo.model ? `${combo.engine}:${combo.model}` : `${combo.engine}:default`;
        const readiness = classifyComboReadiness(health[key], now);
        if (readiness === 'unhealthy') {
            unhealthyCount++;
        } else if (readiness === 'confirmed_healthy') {
            confirmedHealthy.push(combo);
        } else {
            unverified.push(combo);
        }
    }

    const runnablePool = [...confirmedHealthy, ...unverified];
    console.error(
        `[Council Diversity] Validated pool: ${runnablePool.length} runnable` +
        ` (${confirmedHealthy.length} confirmed_healthy, ${unverified.length} unverified,` +
        ` ${unhealthyCount} unhealthy, ${staticRejectedCount} static-rejected)`
    );

    if (runnablePool.length === 0) {
        // All combos excluded — fall back to defaults with explicit notice
        console.error('[Council Diversity] ⚠️  All engine:model combos excluded (unhealthy or invalid) — each role will use engine defaults (degraded mode)');
        return roles.map(() => ({}));
    }

    // Round-robin assignment across runnable pool (confirmed_healthy prioritized)
    const assignments: Array<{ engine?: string; model?: string }> = [];
    for (let i = 0; i < roles.length; i++) {
        const combo = runnablePool[i % runnablePool.length];
        assignments.push({ engine: combo.engine, model: combo.model || undefined });
    }

    const summary = assignments.map((a, i) => `${roles[i]} → ${a.engine}:${a.model || 'default'}`).join(', ');
    console.error(`[Council Diversity] Assigned pool (${roles.length} roles): ${summary}`);

    return assignments;
}

/**
 * Dispatches the council of experts concurrently with automatic cross-model diversity.
 *
 * Pre-spawn artifacts (written before any worker starts):
 *   DISPATCH_MANIFEST.md — audit record of configured vs. validated vs. assigned pools
 *   <role>_review.md     — per-role "in-progress" placeholder (overwritten by real output)
 *
 * Post-spawn artifacts:
 *   FAILURES.md          — partial failure report (if any workers fail)
 *
 * Injectable _spawnOverride allows tests to mock worker execution without real process spawns.
 */
export async function dispatchCouncilConcurrent(
    roles: string[],
    proposalPath: string,
    reviewsPath: string,
    timestampId: string,
    workspacePath: string,
    parentDepth?: number,
    parentIssueNumber?: number,
    roleDescriptions?: Record<string, string>,
    _spawnOverride?: (role: string, proposalPath: string, outputPath: string, sessionId: string, workspacePath: string, parentDepth?: number, parentIssueNumber?: number, roleDescription?: string, engine?: string, model?: string) => Promise<string>
): Promise<string[]> {
  // Ensure reviews directory exists before writing any artifacts
  if (!fs.existsSync(reviewsPath)) {
      fs.mkdirSync(reviewsPath, { recursive: true });
  }

  // Compute diversity assignments — three-state pool with explicit logging
  const diversityAssignments = computeDiversityAssignments(roles, workspacePath);
  const isDegraded = diversityAssignments.every(a => !a.engine && !a.model);

  // --- Pre-spawn: Write DISPATCH_MANIFEST.md ---
  const manifestLines: string[] = [
      `# Council Dispatch Manifest`,
      ``,
      `**Timestamp:** ${new Date().toISOString()}`,
      `**Proposal:** \`${proposalPath}\``,
      `**Roles (${roles.length}):** ${roles.map(r => `\`${r}\``).join(', ')}`,
      `**Mode:** ${isDegraded ? '⚠️  DEGRADED (all combos excluded, using engine defaults)' : 'normal'}`,
      ``,
      `## Role Assignments`,
      ``,
      ...diversityAssignments.map((a, i) =>
          `- \`${roles[i]}\` → engine: \`${a.engine || 'default'}\`, model: \`${a.model || 'default'}\``
      ),
      ``,
      `## Status`,
      ``,
      `pre-spawn (workers not yet started)`,
  ];
  fs.writeFileSync(path.join(reviewsPath, 'DISPATCH_MANIFEST.md'), manifestLines.join('\n') + '\n', 'utf8');

  // --- Pre-spawn: Write per-role placeholder files ---
  for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      const assignment = diversityAssignments[i];
      const placeholderPath = path.join(reviewsPath, `${role}_review.md`);
      const placeholder = [
          `# Review: ${role}`,
          ``,
          `**status:** in-progress`,
          `**engine:** ${assignment.engine || 'default'}`,
          `**model:** ${assignment.model || 'default'}`,
          `**started_at:** ${new Date().toISOString()}`,
          ``,
          `_Worker execution in progress. This file will be overwritten with the actual review output._`,
      ].join('\n') + '\n';
      fs.writeFileSync(placeholderPath, placeholder, 'utf8');
  }
  console.error(`[Council] Pre-spawn artifacts written: DISPATCH_MANIFEST.md + ${roles.length} role placeholders`);

  const spawnFn = _spawnOverride ?? spawnWorker;

  const promises = roles.map((role, i) => {
    const outputPath = path.join(reviewsPath, `${role}_review.md`);
    const assignment = diversityAssignments[i];
    const p = spawnFn(role, proposalPath, outputPath, `${timestampId}_${Math.random().toString(36).slice(2,8)}`, workspacePath, parentDepth, parentIssueNumber, roleDescriptions?.[role], assignment.engine, assignment.model);
    // On spawn failure, overwrite placeholder with a deterministic failure artifact
    return p.catch((err: any) => {
        const failureArtifact = [
            `# Review: ${role}`,
            ``,
            `**status:** failed`,
            `**engine:** ${assignment.engine || 'default'}`,
            `**model:** ${assignment.model || 'default'}`,
            `**failed_at:** ${new Date().toISOString()}`,
            `**error:** ${err?.message || 'Unknown spawn error'}`,
            ``,
            `_Worker failed to produce a review. Check .optimus/agents/ for T1 instance logs._`,
        ].join('\n') + '\n';
        try { fs.writeFileSync(outputPath, failureArtifact, 'utf8'); } catch (_) {}
        throw err;
    });
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
