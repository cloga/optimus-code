import { AUTOMATION_CONTINUATION_VALUES, AUTOMATION_MODE_VALUES } from "../utils/automationPolicy";

export const AVAILABLE_AGENTS_SCHEMA_VERSION = 1;

const ENGINE_PROTOCOL_VALUES = ['cli', 'acp', 'auto'] as const;
const TRANSPORT_PROTOCOL_VALUES = ['cli', 'acp'] as const;
const LEGACY_AUTOMATION_MODE_VALUES = ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'autopilot'] as const;

type EngineProtocol = typeof ENGINE_PROTOCOL_VALUES[number];
type TransportProtocol = typeof TRANSPORT_PROTOCOL_VALUES[number];
type KnownAutomationMode = typeof AUTOMATION_MODE_VALUES[number] | typeof LEGACY_AUTOMATION_MODE_VALUES[number];
type KnownAutomationContinuation = typeof AUTOMATION_CONTINUATION_VALUES[number];

export interface TimeoutConfig {
    heartbeat_ms?: number;
    activity_ms?: number;
}

export interface AutomationConfig {
    mode?: KnownAutomationMode;
    continuation?: KnownAutomationContinuation;
    max_continues?: number;
}

export interface CapabilityConfig {
    automation_modes?: KnownAutomationMode[];
    automation_continuations?: KnownAutomationContinuation[];
}

export interface TransportConfig {
    path?: string;
    args?: string[];
    cli_flags?: string;
    capabilities?: CapabilityConfig;
    timeout?: TimeoutConfig;
    _comment?: string;
    status?: string;
}

export interface EngineConfig extends TransportConfig {
    protocol?: EngineProtocol;
    preferred_protocol?: TransportProtocol;
    adapter?: string;
    family?: string;
    available_models?: string[];
    automation?: AutomationConfig;
    acp?: TransportConfig;
    cli?: TransportConfig;
}

export interface AvailableAgentsConfig {
    $schema?: string;
    _schema_version?: number;
    _comment?: string;
    defaults?: {
        fallback_engine?: string;
    };
    engines: Record<string, EngineConfig>;
}

export class AvailableAgentsConfigError extends Error {
    constructor(message: string) {
        super(
            `[Config] Invalid available-agents.json: ${message}. ` +
            `Suggested fix: update ~/.optimus/config/available-agents.json (default) or .optimus/config/available-agents.json (project override) to match available-agents.schema.json.`
        );
        this.name = 'AvailableAgentsConfigError';
    }
}

function fail(path: string, reason: string): never {
    throw new AvailableAgentsConfigError(`${path} ${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    if (!isPlainObject(value)) {
        fail(path, 'must be an object');
    }
}

function assertOptionalString(value: unknown, path: string): void {
    if (value !== undefined && typeof value !== 'string') {
        fail(path, 'must be a string');
    }
}

function assertOptionalNonNegativeNumber(value: unknown, path: string): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(path, 'must be a non-negative number');
    }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
    if (!Array.isArray(value)) {
        fail(path, 'must be an array of strings');
    }
    value.forEach((item, index) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
            fail(`${path}[${index}]`, 'must be a non-empty string');
        }
    });
}

function assertEnum<T extends readonly string[]>(value: unknown, allowed: T, path: string): asserts value is T[number] {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        fail(path, `must be one of: ${allowed.join(', ')}`);
    }
}

function assertTimeoutConfig(value: unknown, path: string): void {
    if (value === undefined) return;
    assertPlainObject(value, path);
    assertOptionalNonNegativeNumber(value.heartbeat_ms, `${path}.heartbeat_ms`);
    assertOptionalNonNegativeNumber(value.activity_ms, `${path}.activity_ms`);
}

function assertCapabilities(value: unknown, path: string): void {
    if (value === undefined) return;
    assertPlainObject(value, path);
    if (value.automation_modes !== undefined) {
        assertStringArray(value.automation_modes, `${path}.automation_modes`);
        value.automation_modes.forEach((mode, index) => {
            assertEnum(mode, [...AUTOMATION_MODE_VALUES, ...LEGACY_AUTOMATION_MODE_VALUES] as const, `${path}.automation_modes[${index}]`);
        });
    }
    if (value.automation_continuations !== undefined) {
        assertStringArray(value.automation_continuations, `${path}.automation_continuations`);
        value.automation_continuations.forEach((continuation, index) => {
            assertEnum(continuation, AUTOMATION_CONTINUATION_VALUES, `${path}.automation_continuations[${index}]`);
        });
    }
}

function assertAutomationConfig(value: unknown, path: string): void {
    if (value === undefined) return;
    assertPlainObject(value, path);
    if (value.mode !== undefined) {
        assertEnum(value.mode, [...AUTOMATION_MODE_VALUES, ...LEGACY_AUTOMATION_MODE_VALUES] as const, `${path}.mode`);
    }
    if (value.continuation !== undefined) {
        assertEnum(value.continuation, AUTOMATION_CONTINUATION_VALUES, `${path}.continuation`);
    }
    assertOptionalNonNegativeNumber(value.max_continues, `${path}.max_continues`);
}

function assertTransportConfig(value: unknown, path: string): void {
    if (value === undefined) return;
    assertPlainObject(value, path);
    assertOptionalString(value.path, `${path}.path`);
    if (value.args !== undefined) {
        assertStringArray(value.args, `${path}.args`);
    }
    assertOptionalString(value.cli_flags, `${path}.cli_flags`);
    assertCapabilities(value.capabilities, `${path}.capabilities`);
    assertTimeoutConfig(value.timeout, `${path}.timeout`);
    assertOptionalString(value._comment, `${path}._comment`);
    assertOptionalString(value.status, `${path}.status`);
}

function assertEngineConfig(value: unknown, path: string): void {
    assertTransportConfig(value, path);
    assertPlainObject(value, path);

    if (value.protocol !== undefined) {
        assertEnum(value.protocol, ENGINE_PROTOCOL_VALUES, `${path}.protocol`);
    }
    if (value.preferred_protocol !== undefined) {
        assertEnum(value.preferred_protocol, TRANSPORT_PROTOCOL_VALUES, `${path}.preferred_protocol`);
    }
    assertOptionalString(value.adapter, `${path}.adapter`);
    assertOptionalString(value.family, `${path}.family`);
    if (value.available_models !== undefined) {
        assertStringArray(value.available_models, `${path}.available_models`);
    }
    assertAutomationConfig(value.automation, `${path}.automation`);
    assertTransportConfig(value.acp, `${path}.acp`);
    assertTransportConfig(value.cli, `${path}.cli`);

    if (value.protocol === 'auto' && value.acp === undefined && value.cli === undefined) {
        fail(path, `uses protocol 'auto' but does not declare either '${path}.acp' or '${path}.cli'`);
    }
}

export function assertAvailableAgentsConfig(value: unknown): asserts value is AvailableAgentsConfig {
    assertPlainObject(value, 'root');
    assertOptionalString(value.$schema, 'root.$schema');
    assertOptionalString(value._comment, 'root._comment');
    if (value._schema_version !== undefined) {
        const schemaVersion = value._schema_version;
        if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
            fail('root._schema_version', 'must be a positive integer');
        }
    }
    if (value.defaults !== undefined) {
        assertPlainObject(value.defaults, 'root.defaults');
        assertOptionalString(value.defaults.fallback_engine, 'root.defaults.fallback_engine');
    }

    assertPlainObject(value.engines, 'root.engines');
    const engineEntries = Object.entries(value.engines);
    if (engineEntries.length === 0) {
        fail('root.engines', 'must declare at least one engine');
    }

    for (const [engineName, engineConfig] of engineEntries) {
        if (engineName.trim().length === 0) {
            fail('root.engines', 'contains an empty engine key');
        }
        assertEngineConfig(engineConfig, `root.engines.${engineName}`);
    }
}

export function parseAvailableAgentsConfig(value: unknown): AvailableAgentsConfig {
    assertAvailableAgentsConfig(value);
    return value;
}
