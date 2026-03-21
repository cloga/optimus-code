import * as fs from 'fs';
import * as path from 'path';

export type McpConfigTarget = 'runtime' | 'vscode' | 'copilot' | 'claude';

type CanonicalServer = Record<string, any> & {
    clients?: Partial<Record<Exclude<McpConfigTarget, 'runtime'>, Record<string, any>>>;
};

type CanonicalMcpConfig = {
    version?: number;
    servers?: Record<string, CanonicalServer>;
    mcpServers?: Record<string, CanonicalServer>;
};

const WORKSPACE_TOKEN = '${workspaceRoot}';
export const CANONICAL_MCP_CONFIG_RELATIVE_PATH = path.join('.optimus', 'config', 'mcp-servers.json');

function deepMerge<T>(base: T, override: any): T {
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
        return (override === undefined ? base : override) as T;
    }

    const result: Record<string, any> = Array.isArray(base) ? [...(base as unknown as any[])] : { ...(base as any || {}) };
    for (const [key, value] of Object.entries(override)) {
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            result[key] &&
            typeof result[key] === 'object' &&
            !Array.isArray(result[key])
        ) {
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }

    return result as T;
}

function renderString(value: string, target: McpConfigTarget, workspaceRoot: string): string {
    if (value === WORKSPACE_TOKEN) {
        if (target === 'vscode') return '${workspaceFolder}';
        if (target === 'runtime') return workspaceRoot;
        return '.';
    }

    if (value.startsWith(`${WORKSPACE_TOKEN}/`)) {
        const suffix = value.slice(WORKSPACE_TOKEN.length + 1);
        if (target === 'vscode') {
            return `\${workspaceFolder}/${suffix}`;
        }
        if (target === 'runtime') {
            return path.join(workspaceRoot, ...suffix.split('/'));
        }
        return `./${suffix}`;
    }

    return value.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => {
        if (target === 'vscode') {
            return `\${env:${name}}`;
        }
        return process.env[name] || '';
    });
}

function renderValue(value: any, target: McpConfigTarget, workspaceRoot: string): any {
    if (Array.isArray(value)) {
        return value.map(item => renderValue(item, target, workspaceRoot));
    }

    if (!value || typeof value !== 'object') {
        return typeof value === 'string' ? renderString(value, target, workspaceRoot) : value;
    }

    const rendered: Record<string, any> = {};
    for (const [key, nested] of Object.entries(value)) {
        if (key === 'clients') continue;
        rendered[key] = renderValue(nested, target, workspaceRoot);
    }
    return rendered;
}

export function loadCanonicalMcpConfig(workspaceRoot: string): CanonicalMcpConfig | null {
    const configPath = path.join(workspaceRoot, CANONICAL_MCP_CONFIG_RELATIVE_PATH);
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (raw && typeof raw === 'object') {
            return raw as CanonicalMcpConfig;
        }
    } catch {
        return null;
    }

    return null;
}

export function renderCanonicalMcpServers(
    config: CanonicalMcpConfig,
    target: McpConfigTarget,
    workspaceRoot: string
): Record<string, any> {
    const rawServers = config.servers || config.mcpServers || {};
    const rendered: Record<string, any> = {};

    for (const [name, server] of Object.entries(rawServers)) {
        const base = deepMerge<CanonicalServer>({} as CanonicalServer, server);
        const clientOverride = target === 'runtime' ? undefined : server.clients?.[target];
        const merged = clientOverride ? deepMerge(base, clientOverride) : base;
        delete merged.clients;
        rendered[name] = renderValue(merged, target, workspaceRoot);
    }

    return rendered;
}

export function loadProjectMcpServers(
    workspaceRoot: string,
    target: McpConfigTarget
): Record<string, any> | null {
    const canonical = loadCanonicalMcpConfig(workspaceRoot);
    if (canonical) {
        return renderCanonicalMcpServers(canonical, target, workspaceRoot);
    }

    const candidatePaths = [
        path.join(workspaceRoot, '.vscode', 'mcp.json'),
        path.join(workspaceRoot, '.copilot', 'mcp-config.json'),
        path.join(workspaceRoot, '.mcp.json')
    ];

    for (const candidatePath of candidatePaths) {
        if (!fs.existsSync(candidatePath)) {
            continue;
        }

        try {
            const raw = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
            const servers = raw.servers || raw.mcpServers || null;
            if (servers && typeof servers === 'object') {
                return servers;
            }
        } catch {
            continue;
        }
    }

    return null;
}
