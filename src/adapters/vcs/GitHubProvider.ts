import { IVcsProvider, WorkItemResult, PullRequestResult, CommentResult, MergeResult, AdoWorkItemOptions, VcsComment } from './IVcsProvider';

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
        workItemType?: string, // Ignored for GitHub
        _adoOptions?: AdoWorkItemOptions // Accepted but ignored
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
        mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'
    ): Promise<MergeResult> {
        const token = this.getToken();
        if (!token) {
            throw new Error('GitHub token not found in environment variables');
        }

        const prNumber = typeof pullRequestId === 'string' ? parseInt(pullRequestId) : pullRequestId;
        const PROTECTED_BRANCHES = ['master', 'main', 'develop', 'release'];

        try {
            // Fetch PR data to get head/base branch names
            const prResponse = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'Optimus-Agent'
                }
            });

            let headBranch: string | undefined;
            let baseBranch: string | undefined;
            if (prResponse.ok) {
                const prData = await prResponse.json() as any;
                headBranch = prData.head?.ref;
                baseBranch = prData.base?.ref;
            }

            // Perform the merge
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

            if (!response.ok) {
                return { merged: false, headBranch, baseBranch };
            }

            // Delete remote branch (best-effort, skip protected branches)
            if (headBranch && !PROTECTED_BRANCHES.includes(headBranch)) {
                try {
                    await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/git/refs/heads/${headBranch}`, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/vnd.github.v3+json',
                            'User-Agent': 'Optimus-Agent'
                        }
                    });
                } catch {
                    console.error(`[Branch Cleanup] Warning: failed to delete remote branch '${headBranch}'`);
                }
            }

            return { merged: true, headBranch, baseBranch };
        } catch {
            return { merged: false };
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

    async getComments(
        itemType: 'workitem' | 'pullrequest',
        itemId: string | number,
        since?: string
    ): Promise<VcsComment[]> {
        const token = this.getToken();
        if (!token) {
            throw new Error('GitHub token not found in environment variables');
        }

        const id = typeof itemId === 'string' ? parseInt(itemId) : itemId;

        // Both issues and PRs use the same comments endpoint in GitHub
        try {
            const allComments: VcsComment[] = [];
            let url: string | null = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${id}/comments?per_page=100`;
            if (since) {
                url += `&since=${encodeURIComponent(since)}`;
            }

            while (url) {
                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'Optimus-Agent'
                    }
                });

                if (!response.ok) {
                    throw new Error(`GitHub API error: ${response.status} ${await response.text()}`);
                }

                const data = await response.json() as any[];
                for (const comment of data) {
                    allComments.push({
                        id: comment.id,
                        author: comment.user?.login || 'unknown',
                        author_association: comment.author_association,
                        body: comment.body || '',
                        created_at: comment.created_at
                    });
                }

                // Follow Link header pagination
                const linkHeader = response.headers.get('link');
                url = null;
                if (linkHeader) {
                    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
                    if (nextMatch) {
                        url = nextMatch[1];
                    }
                }
            }

            return allComments;
        } catch (error: any) {
            throw new Error(`Failed to get GitHub comments: ${error.message}`);
        }
    }

    getProviderName(): string {
        return 'github';
    }

    private getToken(): string | undefined {
        return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    }
}