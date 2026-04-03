/**
 * Engine/Model Resolution
 *
 * Handles engine configuration loading, model validation, protocol resolution,
 * automation policy checking, transport compatibility, engine health tracking,
 * and heartbeat/activity timeouts.
 *
 * Extracted from worker-spawner.ts for modularity.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { AgentAdapter } from "../adapters/AgentAdapter";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";
import { AcpProcessPool } from "../utils/acpProcessPool";
import { getAutomationCapabilityMode, getClaudePermissionModeForPolicy, normalizeAutomationPolicy } from "../utils/automationPolicy";
import { resolveOptimusPath } from '../utils/worktree';
import { AvailableAgentsConfig, parseAvailableAgentsConfig } from "../types/AvailableAgentsConfig";

// ─── Exported Types ───

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

// ─── Engine Health Types & State ───

export interface EngineHealthEntry {
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

/** Time-to-live for unhealthy status: after this period, allow a probe attempt */
export const ENGINE_HEALTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

// File-level mutex for engine-health.json (same pattern as t3LogMutex)
let engineHealthMutex: Promise<void> = Promise.resolve();

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

export function discoverAcpCli(engine: string): { executable: string; args: string[] } | null {
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

// ─── Engine Health Tracking ───

function getEngineHealthPath(workspacePath: string): string {
    return resolveOptimusPath(workspacePath, 'state', 'engine-health.json');
}

export function loadEngineHealth(workspacePath: string): Record<string, EngineHealthEntry> {
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

export function trackEngineHealth(workspacePath: string, engine: string, model: string, success: boolean): void {
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

export function resolveHealthyModel(workspacePath: string, engine: string, model: string): { engine: string; model: string } {
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
    const now = Date.now();
    const fallbackCandidates: Array<{ engine: string; model: string; scope: 'same-engine' | 'cross-engine' }> = [];

    for (const candidateModel of availModels[engine] || []) {
        if (candidateModel === model) continue;
        fallbackCandidates.push({ engine, model: candidateModel, scope: 'same-engine' });
    }

    for (const candidateEngine of availEngines) {
        if (candidateEngine === engine) continue;
        for (const candidateModel of availModels[candidateEngine] || []) {
            fallbackCandidates.push({ engine: candidateEngine, model: candidateModel, scope: 'cross-engine' });
        }
    }

    const selectedFallback = pickHealthyFallbackCandidate(fallbackCandidates, health, now);
    if (selectedFallback) {
        console.error(
            `[EngineHealth] Fallback selected: ${selectedFallback.engine}/${selectedFallback.model} ` +
            `(${selectedFallback.scope}, readiness=${selectedFallback.readiness}, replacing unhealthy ${engine}/${model})`
        );
        return { engine: selectedFallback.engine, model: selectedFallback.model };
    }

    // 3. All combos unhealthy — escape hatch: return original (R3.4)
    console.error(`[EngineHealth] All engine+model combos are unhealthy. Proceeding with original ${engine}/${model} as last resort.`);
    return { engine, model };
}

/**
 * Combo readiness classification for council diversity assignments:
 *   confirmed_healthy — has recorded successes (status: healthy or degraded)
 *   unverified        — no health history (never been invoked)
 *   unhealthy         — recorded failures within TTL
 */
export type ComboReadiness = 'confirmed_healthy' | 'unverified' | 'unhealthy';

function pickHealthyFallbackCandidate(
    candidates: Array<{ engine: string; model: string; scope: 'same-engine' | 'cross-engine' }>,
    health: Record<string, EngineHealthEntry>,
    now: number
): ({ engine: string; model: string; scope: 'same-engine' | 'cross-engine'; readiness: Exclude<ComboReadiness, 'unhealthy'> }) | undefined {
    const confirmedHealthy: Array<{ engine: string; model: string; scope: 'same-engine' | 'cross-engine'; readiness: 'confirmed_healthy' }> = [];
    const unverified: Array<{ engine: string; model: string; scope: 'same-engine' | 'cross-engine'; readiness: 'unverified' }> = [];

    for (const candidate of candidates) {
        const readiness = classifyComboReadiness(health[`${candidate.engine}:${candidate.model}`], now);
        if (readiness === 'unhealthy') {
            continue;
        }
        if (readiness === 'confirmed_healthy') {
            confirmedHealthy.push({ ...candidate, readiness });
        } else {
            unverified.push({ ...candidate, readiness });
        }
    }

    return confirmedHealthy[0] ?? unverified[0];
}

export function classifyComboReadiness(entry: EngineHealthEntry | undefined, now: number): ComboReadiness {
    if (!entry) return 'unverified';
    if (entry.status === 'unhealthy' && (now - new Date(entry.last_failure).getTime()) < ENGINE_HEALTH_TTL_MS) {
        return 'unhealthy';
    }
    // Has at least one recorded success → confirmed healthy
    if (entry.successes > 0) return 'confirmed_healthy';
    return 'unverified';
}

// ─── Engine/Model Validation (prevents corrupted T2 templates) ───

export function loadValidEnginesAndModels(workspacePath: string): { engines: string[]; models: Record<string, string[]> } {
    const engineEntries = loadStaticValidationEngineEntries(workspacePath);
    const engines = Object.keys(engineEntries);
    if (engines.length > 0) {
        const models: Record<string, string[]> = {};
        for (const eng of engines) {
            models[eng] = Array.isArray(engineEntries[eng]?.available_models) ? engineEntries[eng].available_models : [];
        }
        return { engines, models };
    }
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

/**
 * Lenient raw reader: extracts the engines object from available-agents.json
 * without strict schema validation. Used as a fallback when the strict parser
 * rejects the entire config due to per-engine issues (e.g. malformed models).
 */
export function readRawEngineEntries(configPath: string): Record<string, any> | null {
    try {
        if (!fs.existsSync(configPath)) return null;
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (raw && typeof raw.engines === 'object' && raw.engines !== null) {
            return raw.engines;
        }
    } catch {}
    return null;
}

/**
 * System defaults for ACP + autopilot mode.
 * These are injected into engine configs so the config file only needs
 * engine names, models, and optionally ACP paths / timeouts.
 */
const ENGINE_SYSTEM_DEFAULTS: Record<string, any> = {
    'github-copilot': {
        protocol: 'acp',
        automation: { mode: 'auto-approve', continuation: 'autopilot', max_continues: 8 },
        acp: {
            path: 'copilot', args: ['--acp', '--stdio'],
            capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single', 'autopilot'] }
        }
    },
    'claude-code': {
        protocol: 'acp',
        automation: { mode: 'auto-approve', continuation: 'autopilot', max_continues: 8 },
        acp: {
            path: 'claude-agent-acp',
            capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single', 'autopilot'] }
        }
    },
    '_default': {
        protocol: 'acp',
        automation: { mode: 'auto-approve', continuation: 'autopilot', max_continues: 8 },
        acp: { capabilities: { automation_modes: ['auto-approve'], automation_continuations: ['single', 'autopilot'] } }
    }
};

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneConfigValue<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(item => cloneConfigValue(item)) as T;
    }
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entryValue]) => [key, cloneConfigValue(entryValue)])
        ) as T;
    }
    return value;
}

function mergeConfigValue(base: any, override: any): any {
    if (override === undefined) {
        return cloneConfigValue(base);
    }
    if (Array.isArray(override)) {
        return cloneConfigValue(override);
    }
    if (isPlainObject(base) && isPlainObject(override)) {
        const merged: Record<string, any> = {};
        const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
        for (const key of keys) {
            merged[key] = mergeConfigValue(base[key], override[key]);
        }
        return merged;
    }
    if (isPlainObject(override)) {
        return mergeConfigValue({}, override);
    }
    return cloneConfigValue(override);
}

function getUserAvailableAgentsConfigPath(): string {
    return process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH || path.join(os.homedir(), '.optimus', 'config', 'available-agents.json');
}

interface AvailableAgentsConfigReadResult {
    config: AvailableAgentsConfig | null;
    hadError: boolean;
}

function readAvailableAgentsConfigFileWithStatus(configPath: string, sourceLabel: string): AvailableAgentsConfigReadResult {
    try {
        return {
            config: readAvailableAgentsConfigFile(configPath),
            hadError: false,
        };
    } catch (e: any) {
        console.error(`[EngineValidation] Warning: failed to read ${sourceLabel} available-agents.json at '${configPath}': ${e.message}`);
        return {
            config: null,
            hadError: true,
        };
    }
}

function applyEngineDefaults(engine: string, config: any): any {
    const defaults = ENGINE_SYSTEM_DEFAULTS[engine] || ENGINE_SYSTEM_DEFAULTS['_default'];
    if (!config) {
        return cloneConfigValue(defaults);
    }
    // Preserve legacy behavior for verbose engine declarations that manage
    // their own transport/automation semantics explicitly.
    if (config.protocol !== undefined || config.cli || config.capabilities) {
        return cloneConfigValue(config);
    }
    return mergeConfigValue(defaults, config);
}

function buildEffectiveAvailableAgentsConfig(
    userConfig: AvailableAgentsConfig | null,
    projectConfig: AvailableAgentsConfig | null
): AvailableAgentsConfig | null {
    if (!userConfig && !projectConfig) {
        return null;
    }

    const merged = mergeConfigValue(userConfig || {}, projectConfig || {});
    const configuredEngines = isPlainObject(merged.engines) ? merged.engines : {};
    const configuredEngineNames = Object.keys(configuredEngines);
    if (configuredEngineNames.length === 0) {
        return null;
    }
    const effectiveEngines: Record<string, any> = {};

    for (const engine of configuredEngineNames) {
        effectiveEngines[engine] = applyEngineDefaults(engine, configuredEngines[engine]);
    }

    return {
        ...merged,
        engines: effectiveEngines,
    };
}

export function loadAvailableAgentsConfig(workspacePath?: string): AvailableAgentsConfig | null {
    if (!workspacePath) return null;

    const userConfigPath = getUserAvailableAgentsConfigPath();
    const projectConfigPath = resolveOptimusPath(workspacePath, 'config', 'available-agents.json');
    const userConfig = readAvailableAgentsConfigFileWithStatus(userConfigPath, 'user').config;
    const projectConfig = readAvailableAgentsConfigFileWithStatus(projectConfigPath, 'project').config;

    return buildEffectiveAvailableAgentsConfig(userConfig, projectConfig);
}

function loadStaticValidationEngineEntries(workspacePath?: string): Record<string, any> {
    if (!workspacePath) return {};

    const userConfigPath = getUserAvailableAgentsConfigPath();
    const projectConfigPath = resolveOptimusPath(workspacePath, 'config', 'available-agents.json');
    const userResult = readAvailableAgentsConfigFileWithStatus(userConfigPath, 'user');
    const projectResult = readAvailableAgentsConfigFileWithStatus(projectConfigPath, 'project');
    const mergedEngines = mergeConfigValue(
        userResult.config?.engines || {},
        projectResult.config?.engines || {},
    );

    if (projectResult.hadError) {
        const rawProjectEngines = readRawEngineEntries(projectConfigPath);
        if (rawProjectEngines) {
            return mergeConfigValue(mergedEngines, rawProjectEngines);
        }
    }

    return mergedEngines;
}

export function getEngineConfig(engine: string, workspacePath?: string): any | null {
    const raw = loadAvailableAgentsConfig(workspacePath)?.engines?.[engine] || null;
    return raw ? applyEngineDefaults(engine, raw) : null;
}

export function getConfiguredEngineNames(workspacePath?: string): string[] {
    return Object.keys(loadAvailableAgentsConfig(workspacePath)?.engines || {});
}

export function getTransportConfig(engineConfig: any, protocol: 'cli' | 'acp'): any {
    if (!engineConfig) return null;
    if (engineConfig.protocol === 'auto') {
        return engineConfig[protocol] || null;
    }
    const explicitProtocol = engineConfig.protocol === 'acp' ? 'acp' : 'cli';
    if (explicitProtocol !== protocol) return null;
    // Prefer protocol sub-object if it exists (has capabilities), else fall back to parent
    return engineConfig[protocol] || engineConfig;
}

export function getDefaultProtocolForEngine(engine: string): 'cli' | 'acp' {
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

export function getDocumentedDefaultAcpArgs(engine: string): string[] {
    // GitHub Copilot ACP is a documented public-preview transport. The summary
    // `copilot --help` output may only advertise `--acp`, while the ACP docs
    // also document `--stdio` / `--port` server modes. Optimus runs ACP over
    // stdio, so default Copilot ACP launches to `copilot --acp --stdio` unless
    // config explicitly overrides the transport args.
    const normalizedEngine = engine.toLowerCase();
    if (normalizedEngine.includes('copilot') || normalizedEngine.includes('claude')) {
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
        if (protocol === 'acp') {
            return `Ensure acp.capabilities.automation_continuations includes 'autopilot' in available-agents.json for engine '${engine}'. System defaults should provide this — try running 'npx github:cloga/optimus-code upgrade' to refresh config.`;
        }
        if (!engine.toLowerCase().includes('copilot')) {
            return `Switch to protocol 'acp' for engine '${engine}' (supports autopilot via system defaults), or set automation.continuation to 'single'.`;
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

export function resolveProtocolFromEngineConfig(engine: string, engineConfig: any): 'cli' | 'acp' {
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

// ─── Heartbeat & Activity Timeouts ───

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

// ─── Engine/Model Validation ───

export function isValidEngine(engine: string, validEngines: string[]): boolean {
    return validEngines.length === 0 || validEngines.includes(engine);
}

export function isValidModel(model: string, engine: string, validModels: Record<string, string[]>): boolean {
    const allowed = validModels[engine];
    if (!allowed || allowed.length === 0) return true; // no config = permissive
    return allowed.includes(model);
}

// ─── Static Validation ───

/**
 * Static validation: reject combos that cannot possibly work before any health
 * check. This catches "phantom capacity" from malformed config entries.
 *
 * Rules:
 *   - Engine path must be non-empty (checked via available-agents.json)
 *   - If an engine lists available_models, each model string must be non-empty
 */
export function isStaticallyValid(eng: string, mdl: string, workspacePath?: string): boolean {
    try {
        const engineEntries = loadStaticValidationEngineEntries(workspacePath);
        const engineConfig = engineEntries[eng] ? applyEngineDefaults(eng, engineEntries[eng]) : null;
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

// ─── Transport Resolution & Explanation ───

export function buildResolvedTransportForProtocol(
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

// ─── Public API ───

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

export function getAdapterForEngine(engine: string, sessionId?: string, model?: string, workspacePath?: string): AgentAdapter {
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

// ─── parseRoleSpec ───

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
