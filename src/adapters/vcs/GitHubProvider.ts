import { IVcsProvider, WorkItemResult, PullRequestResult, CommentResult } from './IVcsProvider';

/**
 * GitHub VCS Provider Implementation
 *
 * Implements the unified VCS interface using GitHub's REST API.
 * Reuses existing patterns from src/utils/githubApi.ts for consistency.
 */
export class GitHubProvider implements IVcsProvider {
    private owner: string;
    private repo: string;

    constructor(owner: string, repo: string) {
        this.owner = owner;
        this.repo = repo;
    }

    async createWorkItem(
        title: string,
        body: string,
        labels?: string[],
        workItemType?: string // Ignored for GitHub
    ): Promise<WorkItemResult> {
        const token = this.getToken();
        if (!token) {
            throw new Error('GitHub token not found in environment variables');
        }

        // Auto-tag: prefix title and ensure optimus-bot label
        const taggedTitle = title.startsWith('[Optimus]') ? title : `[Optimus] ${title}`;
        const issueLabels = Array.isArray(labels) ? [...labels] : [];
        if (!issueLabels.includes('optimus-bot')) {
            issueLabels.push('optimus-bot');
        }

        try {
            const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/issues`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Optimus-Agent'
                },
                body: JSON.stringify({
                    title: taggedTitle,
                    body,
                    labels: issueLabels
                })
            });

            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
            }

            const data = await response.json() as any;

            return {
                id: data.id.toString(),
                number: data.number,
                url: data.html_url,
                title: data.title
            };
        } catch (error: any) {
            throw new Error(`Failed to create GitHub issue: ${error.message}`);
        }
    }

    async createPullRequest(
        title: string,
        body: string,
        head: string,
        base: string
    ): Promise<PullRequestResult> {
        const token = this.getToken();
        if (!token) {
            throw new Error('GitHub token not found in environment variables');
        }

        // Auto-tag: prefix PR title
        const taggedTitle = title.startsWith('[Optimus]') ? title : `[Optimus] ${title}`;

        try {
            const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Optimus-Agent'
                },
                body: JSON.stringify({
                    title: taggedTitle,
                    head,
                    base,
                    body: body || ''
                })
            });

            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
            }

            const data = await response.json() as any;

            // Auto-label: add optimus-bot label to the PR (best effort)
            try {
                await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/issues/${data.number}/labels`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json',
                        'User-Agent': 'Optimus-Agent'
                    },
                    body: JSON.stringify({ labels: ['optimus-bot'] })
                });
            } catch {
                // Label is best-effort, don't fail the PR creation
            }

            return {
                id: data.id.toString(),
                number: data.number,
                url: data.html_url,
                title: data.title
            };
        } catch (error: any) {
            throw new Error(`Failed to create GitHub pull request: ${error.message}`);
        }
    }

    async mergePullRequest(
        pullRequestId: string | number,
        commitTitle?: string,
        mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'
    ): Promise<boolean> {
        const token = this.getToken();
        if (!token) {
            throw new Error('GitHub token not found in environment variables');
        }

        const prNumber = typeof pullRequestId === 'string' ? parseInt(pullRequestId) : pullRequestId;

        try {
            const payload: any = { merge_method: mergeMethod };
            if (commitTitle) {
                payload.commit_title = commitTitle;
            }

            const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Optimus-Agent'
                },
                body: JSON.stringify(payload)
            });

            return response.ok;
        } catch {
            return false;
        }
    }

    async addComment(
        itemType: 'workitem' | 'pullrequest',
        itemId: string | number,
        comment: string
    ): Promise<CommentResult> {
        const token = this.getToken();
        if (!token) {
            throw new Error('GitHub token not found in environment variables');
        }

        const id = typeof itemId === 'string' ? parseInt(itemId) : itemId;

        // Both issues and PRs use the same comments endpoint in GitHub
        try {
            const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/issues/${id}/comments`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Optimus-Agent'
                },
                body: JSON.stringify({ body: comment })
            });

            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
            }

            const data = await response.json() as any;

            return {
                id: data.id.toString(),
                url: data.html_url
            };
        } catch (error: any) {
            throw new Error(`Failed to add GitHub comment: ${error.message}`);
        }
    }

    getProviderName(): string {
        return 'github';
    }

    private getToken(): string | undefined {
        return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    }
}