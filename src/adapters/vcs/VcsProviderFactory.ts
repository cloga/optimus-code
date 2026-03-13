import { IVcsProvider } from './IVcsProvider';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

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
        defaults?: {
            work_item_type?: string;
            area_path?: string;
            iteration_path?: string;
            assigned_to?: string;
            auto_tags?: string[];
        };
    };
}

/**
 * VCS Provider Factory
 *
 * Factory Pattern: Creates appropriate VCS provider instances with lazy loading.
 * Implements auto-detection logic based on git remote URL and configuration.
 */
export class VcsProviderFactory {
    private static cachedProvider: IVcsProvider | null = null;
    private static cachedConfigPath: string | null = null;
    private static cachedConfigHash: string | null = null;

    /**
     * Get the appropriate VCS provider for the workspace
     *
     * @param workspacePath - Path to the workspace root
     * @returns Promise resolving to the appropriate VCS provider
     */
    public static async getProvider(workspacePath?: string): Promise<IVcsProvider> {
        const resolvedWorkspacePath = workspacePath || process.cwd();

        // Return cached provider if available and config hasn't changed
        const configPath = this.getConfigPath(resolvedWorkspacePath);
        const configContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
        const configHash = crypto.createHash('md5').update(configContent).digest('hex');
        if (this.cachedProvider && this.cachedConfigPath === configPath && this.cachedConfigHash === configHash) {
            return this.cachedProvider;
        }

        // Load configuration
        const config = this.loadConfig(resolvedWorkspacePath);
        let providerType = config.provider || 'auto-detect';

        // Auto-detect provider if not explicitly configured
        if (providerType === 'auto-detect') {
            providerType = this.detectProviderFromGitRemote(resolvedWorkspacePath);
        }

        // Create provider instance using lazy loading
        let provider: IVcsProvider;

        if (providerType === 'github') {
            const { owner, repo } = this.getGitHubInfo(config, resolvedWorkspacePath);
            const { GitHubProvider } = await import('./GitHubProvider');
            provider = new GitHubProvider(owner, repo);
        } else if (providerType === 'azure-devops') {
            const { organization, project } = this.getAdoInfo(config, resolvedWorkspacePath);
            const { AdoProvider } = await import('./AdoProvider');
            const adoDefaults = config.ado?.defaults;
            provider = new AdoProvider(organization, project, adoDefaults);
        } else {
            throw new Error(`Unsupported or undetectable VCS provider: ${providerType}`);
        }

        // Cache the provider, config path, and hash
        this.cachedProvider = provider;
        this.cachedConfigPath = configPath;
        this.cachedConfigHash = configHash;

        return provider;
    }

    /**
     * Clear the cached provider (useful for testing or configuration changes)
     */
    public static clearCache(): void {
        this.cachedProvider = null;
        this.cachedConfigPath = null;
        this.cachedConfigHash = null;
    }

    private static getConfigPath(workspacePath: string): string {
        return path.join(workspacePath, '.optimus', 'config', 'vcs.json');
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

    private static detectProviderFromGitRemote(workspacePath: string): 'github' | 'azure-devops' {
        try {
            const remoteUrl = execSync('git remote get-url origin', {
                cwd: workspacePath,
                encoding: 'utf8'
            }).trim();

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
            const remoteUrl = execSync('git remote get-url origin', {
                cwd: workspacePath,
                encoding: 'utf8'
            }).trim();

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

    private static getAdoInfo(config: VcsConfig, workspacePath: string): { organization: string; project: string } {
        // Use explicit config if available
        if (config.ado?.organization && config.ado?.project) {
            return {
                organization: config.ado.organization,
                project: config.ado.project
            };
        }

        // Extract from git remote URL
        try {
            const remoteUrl = execSync('git remote get-url origin', {
                cwd: workspacePath,
                encoding: 'utf8'
            }).trim();

            // Parse Azure DevOps URL patterns:
            // https://dev.azure.com/organization/project/_git/repo
            // https://organization.visualstudio.com/project/_git/repo
            let match = remoteUrl.match(/dev\.azure\.com[\/:]([^\/]+)\/([^\/_]+)/);
            if (match) {
                return {
                    organization: match[1],
                    project: match[2]
                };
            }

            match = remoteUrl.match(/([^.]+)\.visualstudio\.com[\/:]([^\/_]+)/);
            if (match) {
                return {
                    organization: match[1],
                    project: match[2]
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