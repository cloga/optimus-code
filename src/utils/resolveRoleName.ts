import fs from "fs";
import path from "path";

interface RoleEntry {
    aliases: string[];
    category?: string;
    description?: string;
}

interface RoleRegistry {
    roles: Record<string, RoleEntry>;
}

// Cache with mtime check to avoid repeated file reads
let cachedRegistry: RoleRegistry | null = null;
let cachedMtime: number = 0;
let cachedPath: string = "";

function getRegistryPath(workspacePath: string): string {
    return path.join(workspacePath, ".optimus", "config", "role-registry.json");
}

function loadRegistry(workspacePath: string): RoleRegistry {
    const registryPath = getRegistryPath(workspacePath);
    try {
        if (!fs.existsSync(registryPath)) {
            return { roles: {} };
        }
        const stat = fs.statSync(registryPath);
        if (cachedRegistry && cachedPath === registryPath && cachedMtime === stat.mtimeMs) {
            return cachedRegistry;
        }
        const content = fs.readFileSync(registryPath, "utf8");
        const registry = JSON.parse(content) as RoleRegistry;
        cachedRegistry = registry;
        cachedMtime = stat.mtimeMs;
        cachedPath = registryPath;
        return registry;
    } catch (e: any) {
        console.error(`[RoleRegistry] Warning: failed to read registry at ${registryPath}: ${e.message}`);
        return { roles: {} };
    }
}

/**
 * Resolve a role name (possibly an alias) to its canonical name.
 * Case-insensitive. Returns the original name if no alias match is found (T3 passthrough).
 */
export function resolveRoleName(role: string, workspacePath: string): string {
    const registry = loadRegistry(workspacePath);
    const lower = role.toLowerCase();

    // Check if it's already a canonical name
    for (const canonical of Object.keys(registry.roles)) {
        if (canonical.toLowerCase() === lower) {
            return canonical;
        }
    }

    // Check aliases
    for (const [canonical, entry] of Object.entries(registry.roles)) {
        if (entry.aliases.some(a => a.toLowerCase() === lower)) {
            console.error(`[RoleRegistry] Resolved alias '${role}' → '${canonical}'`);
            return canonical;
        }
    }

    // No match — passthrough for T3
    return role;
}

/**
 * Batch resolve role names for council dispatch.
 */
export function resolveRoleNames(roles: string[], workspacePath: string): string[] {
    return roles.map(r => resolveRoleName(r, workspacePath));
}

/**
 * Get all registered roles with their aliases and categories.
 */
export function getRegisteredRoles(workspacePath: string): Array<{ canonical: string; aliases: string[]; category?: string }> {
    const registry = loadRegistry(workspacePath);
    return Object.entries(registry.roles).map(([canonical, entry]) => ({
        canonical,
        aliases: entry.aliases,
        category: entry.category
    }));
}

/**
 * Auto-register a new role in the registry when a T2 is created.
 * Defensive: catches all errors and never throws.
 * Does not overwrite existing entries — only adds new canonical names.
 */
export function registerRole(workspacePath: string, roleName: string, description?: string): void {
    try {
        const registryPath = getRegistryPath(workspacePath);
        let registry: RoleRegistry = { roles: {} };

        if (fs.existsSync(registryPath)) {
            const content = fs.readFileSync(registryPath, "utf8");
            registry = JSON.parse(content);
        }

        const lower = roleName.toLowerCase();

        // Don't overwrite existing entry
        if (registry.roles[roleName]) return;
        // Check case-insensitive too
        for (const existing of Object.keys(registry.roles)) {
            if (existing.toLowerCase() === lower) return;
        }

        // Add new entry
        registry.roles[roleName] = {
            aliases: [],
            category: "auto",
            ...(description ? { description: description.substring(0, 200) } : {})
        };

        // Ensure directory exists
        const dir = path.dirname(registryPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

        // Invalidate cache
        cachedRegistry = null;
        cachedMtime = 0;

        console.error(`[RoleRegistry] Auto-registered new role '${roleName}'`);
    } catch (e: any) {
        console.error(`[RoleRegistry] Warning: failed to auto-register role '${roleName}': ${e.message}`);
    }
}
