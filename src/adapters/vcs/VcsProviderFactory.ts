import { IVcsProvider } from './IVcsProvider';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { execSync } from 'child_process';
import { detectWorktreeContext, resolveOptimusPath } from '../../utils/worktree';

export interface VcsConfig {
    provider?: 'auto-detect' | 'github' | 'azure-devops';
    github?: {
        auth?: string;
        owner: string;
        repo: string;
    };
    ado?: {
        auth?: string;
        organization: string;
        project: string;
        web_base_url?: string;
        defaults?: {
            work_item_type?: string;
            area_path?: string;
            iteration_path?: string;
            assigned_to?: string;
            auto_tags?: string[];
        };
    };
}

type VcsProviderCacheEntry = {
    provider: IVcsProvider;
    configHash: string;
    gitRemote: string;
    resolvedAt: number;
};

export interface VcsConfigDiagnostics {
    workspacePath: string;
    resolvedConfigPath: string;
    fileExists: boolean;
    configHash: string | null;
    gitRemote: string;
    cacheHit: boolean;
    cacheAgeMs?: number;
    configuredProvider: string;
    resolutionChain: string[];
}

/**
 * VCS Provider Factory
 *
 * Factory Pattern: Creates appropriate VCS provider instances with lazy loading.
 * Implements auto-detection logic based on git remote URL and configuration.
 */
export class VcsProviderFactory {
    private static providerCache = new Map<string, VcsProviderCacheEntry>();
    private static readonly GIT_COMMAND_TIMEOUT_MS = 2000;

    /**
     * Get the appropriate VCS provider for the workspace
     *
     * @param workspacePath - Path to the workspace root
     * @returns Promise resolving to the appropriate VCS provider
     */
    public static async getProvider(workspacePath?: string): Promise<IVcsProvider> {
        const resolvedWorkspacePath = path.resolve(workspacePath || process.cwd());

        // Return cached provider if available and config hasn't changed
        const configPath = this.getConfigPath(resolvedWorkspacePath);
        const configContent = this.readConfigContent(configPath);
        const configHash = this.hashConfigContent(configContent);
        const gitRemote = this.getGitRemote(resolvedWorkspacePath);
        const cacheKey = this.getCacheKey(resolvedWorkspacePath, configPath);
        const cached = this.providerCache.get(cacheKey);
        if (cached && cached.configHash === configHash && cached.gitRemote === gitRemote) {
            return cached.provider;
        }

        // Load configuration
        const config = this.loadConfig(resolvedWorkspacePath);
        let providerType = config.provider || 'auto-detect';

        // Auto-detect provider if not explicitly configured
        if (providerType === 'auto-detect') {
            // Check explicit config fields before falling back to git remote
            if (config.ado?.organization && config.ado?.project) {
                providerType = 'azure-devops';
            } else if (config.github?.owner && config.github?.repo) {
                providerType = 'github';
            } else {
                providerType = this.detectProviderFromGitRemote(resolvedWorkspacePath);
            }
        }

        // Create provider instance using lazy loading
        let provider: IVcsProvider;

        if (providerType === 'github') {
            const { owner, repo } = this.getGitHubInfo(config, resolvedWorkspacePath);
            const { GitHubProvider } = await import('./GitHubProvider.js');
            provider = new GitHubProvider(owner, repo);
        } else if (providerType === 'azure-devops') {
            const { organization, project, webBaseUrl } = this.getAdoInfo(config, resolvedWorkspacePath);
            const { AdoProvider } = await import('./AdoProvider.js');
            const adoDefaults = config.ado?.defaults;
            provider = new AdoProvider(organization, project, adoDefaults, webBaseUrl, config.ado?.auth);
        } else {
            throw new Error(`Unsupported or undetectable VCS provider: ${providerType}`);
        }

        // Cache the provider, config path, and hash
        this.providerCache.set(cacheKey, {
            provider,
            configHash,
            gitRemote,
            resolvedAt: Date.now()
        });

        return provider;
    }

    /**
     * Clear the cached provider (useful for testing or configuration changes)
     */
    public static clearCache(): void {
        this.providerCache.clear();
    }

    public static getConfigDiagnostics(workspacePath: string): VcsConfigDiagnostics {
        const resolvedWorkspacePath = path.resolve(workspacePath);
        const ctx = detectWorktreeContext(resolvedWorkspacePath);
        const resolvedConfigPath = this.getConfigPath(resolvedWorkspacePath);
        const fileExists = fs.existsSync(resolvedConfigPath);
        const configContent = this.readConfigContent(resolvedConfigPath);
        const configHash = fileExists ? this.hashConfigContent(configContent) : null;
        const gitRemote = this.getGitRemote(resolvedWorkspacePath);
        const cacheKey = this.getCacheKey(resolvedWorkspacePath, resolvedConfigPath);
        const cached = this.providerCache.get(cacheKey);
        const configuredProvider = this.readConfiguredProvider(configContent);
        const mainPath = path.join(ctx.mainRoot, '.optimus', 'config', 'vcs.json');
        const localPath = path.join(ctx.currentRoot, '.optimus', 'config', 'vcs.json');
        const userPath = path.join(os.homedir(), '.optimus', 'config', 'vcs.json');
        const resolutionChain = ctx.isWorktree
            ? [
                `main worktree: ${mainPath}${fs.existsSync(mainPath) ? ' [exists]' : ' [missing]'}`,
                `worktree local: ${localPath}${fs.existsSync(localPath) ? ' [exists]' : ' [missing]'}`,
                `user fallback: ${userPath}${fs.existsSync(userPath) ? ' [exists]' : ' [missing]'}`
            ]
            : [
                `project: ${localPath}${fs.existsSync(localPath) ? ' [exists]' : ' [missing]'}`,
                `user fallback: ${userPath}${fs.existsSync(userPath) ? ' [exists]' : ' [missing]'}`
            ];

        return {
            workspacePath: resolvedWorkspacePath,
            resolvedConfigPath,
            fileExists,
            configHash,
            gitRemote,
            cacheHit: !!cached,
            cacheAgeMs: cached ? Date.now() - cached.resolvedAt : undefined,
            configuredProvider,
            resolutionChain
        };
    }

    private static getConfigPath(workspacePath: string): string {
        return resolveOptimusPath(workspacePath, 'config', 'vcs.json');
    }

    private static getCacheKey(workspacePath: string, configPath: string): string {
        return `${path.resolve(workspacePath)}::${path.resolve(configPath)}`;
    }

    private static readConfigContent(configPath: string): string {
        return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    }

    private static hashConfigContent(configContent: string): string {
        return crypto.createHash('md5').update(configContent).digest('hex');
    }

    private static loadConfig(workspacePath: string): VcsConfig {
        const configPath = this.getConfigPath(workspacePath);

        if (fs.existsSync(configPath)) {
            try {
                const configContent = fs.readFileSync(configPath, 'utf8');
                return JSON.parse(configContent) as VcsConfig;
            } catch (error) {
                console.error(`Warning: Failed to parse VCS config at ${configPath}:`, error);
            }
        }

        return { provider: 'auto-detect' };
    }

    private static readConfiguredProvider(configContent: string): string {
        if (!configContent) {
            return 'auto-detect';
        }

        try {
            const config = JSON.parse(configContent) as VcsConfig;
            return config.provider || 'auto-detect';
        } catch {
            return 'invalid-json';
        }
    }

    private static runGitCommand(workspacePath: string, command: string): string {
        return execSync(command, {
            cwd: workspacePath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: this.GIT_COMMAND_TIMEOUT_MS
        }).trim();
    }

    private static getGitRemote(workspacePath: string): string {
        try {
            return this.runGitCommand(workspacePath, 'git remote get-url origin');
        } catch {
            return 'unknown';
        }
    }

    private static detectProviderFromGitRemote(workspacePath: string): 'github' | 'azure-devops' {
        try {
            const remoteUrl = this.runGitCommand(workspacePath, 'git remote get-url origin');

            // Check for GitHub patterns
            if (remoteUrl.includes('github.com')) {
                return 'github';
            }

            // Check for Azure DevOps patterns
            if (remoteUrl.includes('dev.azure.com') || remoteUrl.includes('visualstudio.com')) {
                return 'azure-devops';
            }

            // Default to GitHub if unable to detect
            console.warn(`Unable to detect VCS provider from remote URL: ${remoteUrl}. Defaulting to GitHub.`);
            return 'github';
        } catch (error: any) {
            console.warn('Failed to detect git remote URL: ' + error.message + '. Defaulting to GitHub.');
            return 'github';
        }
    }

    private static getGitHubInfo(config: VcsConfig, workspacePath: string): { owner: string; repo: string } {
        // Use explicit config if available
        if (config.github?.owner && config.github?.repo) {
            return {
                owner: config.github.owner,
                repo: config.github.repo
            };
        }

        // Extract from git remote URL
        try {
            const remoteUrl = this.runGitCommand(workspacePath, 'git remote get-url origin');

            // Parse HTTPS URL: https://github.com/owner/repo.git
            const httpsMatch = remoteUrl.match(/github\.com[\/:]+([^\/]+)\/([^\/.]+)/);
            if (httpsMatch) {
                return {
                    owner: httpsMatch[1],
                    repo: httpsMatch[2]
                };
            }

            throw new Error('Unable to parse GitHub repository info from remote URL');
        } catch (error: any) {
            throw new Error(
                'Failed to auto-detect GitHub info: git not found in PATH or not a git repository. ' +
                'Set "owner" and "repo" explicitly in .optimus/config/vcs.json'
            );
        }
    }

    private static getAdoInfo(config: VcsConfig, workspacePath: string): { organization: string; project: string; webBaseUrl: string } {
        // Use explicit config if available
        if (config.ado?.organization && config.ado?.project) {
            return {
                organization: config.ado.organization,
                project: config.ado.project,
                webBaseUrl: config.ado.web_base_url || `https://${config.ado.organization}.visualstudio.com`
            };
        }

        // Extract from git remote URL
        try {
            const remoteUrl = this.runGitCommand(workspacePath, 'git remote get-url origin');

            // Parse Azure DevOps URL patterns:
            // https://dev.azure.com/organization/project/_git/repo
            // https://organization.visualstudio.com/project/_git/repo
            let match = remoteUrl.match(/dev\.azure\.com[\/:]([^\/]+)\/([^\/_]+)/);
            if (match) {
                return {
                    organization: match[1],
                    project: decodeURIComponent(match[2]),
                    webBaseUrl: `https://dev.azure.com/${match[1]}`
                };
            }

            match = remoteUrl.match(/([^.]+)\.visualstudio\.com[\/:]([^\/_]+)/);
            if (match) {
                return {
                    organization: match[1],
                    project: decodeURIComponent(match[2]),
                    webBaseUrl: `https://${match[1]}.visualstudio.com`
                };
            }

            throw new Error('Unable to parse Azure DevOps repository info from remote URL');
        } catch (error: any) {
            throw new Error(
                'Failed to auto-detect Azure DevOps info: git not found in PATH or not a git repository. ' +
                'Set "organization" and "project" explicitly in .optimus/config/vcs.json'
            );
        }
    }

    /**
     * Create a provider configuration file in the workspace
     *
     * @param workspacePath - Path to the workspace root
     * @param config - Configuration to save
     */
    public static createConfig(workspacePath: string, config: VcsConfig): void {
        const configPath = this.getConfigPath(workspacePath);
        const configDir = path.dirname(configPath);

        // Ensure config directory exists
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    }
}
