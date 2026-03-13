import { IVcsProvider, WorkItemResult, PullRequestResult, CommentResult, MergeResult, AdoWorkItemOptions } from './IVcsProvider';
import { marked } from 'marked';

/**
 * Azure DevOps VCS Provider Implementation
 *
 * Implements the unified VCS interface using Azure DevOps REST API.
 * Uses Personal Access Tokens (PATs) for authentication.
 */
function adoHttpRecoveryHint(status: number): string {
    const hints: Record<number, string> = {
        401: "ADO PAT may be expired or invalid. Regenerate at dev.azure.com > User Settings > Personal Access Tokens.",
        403: "Insufficient permissions. Verify the PAT has the required scopes (Code: Read&Write, Work Items: Read&Write).",
        404: "Resource not found. Verify org/project/repo names in .optimus/config/vcs.json match your Azure DevOps setup.",
        409: "Conflict detected. The resource may have been modified concurrently. Retry the operation."
    };
    return hints[status] || "Unexpected HTTP " + status + ". Check ADO service health at https://status.dev.azure.com.";
}

export class AdoProvider implements IVcsProvider {
    private organization: string;
    private project: string;
    private defaults?: {
        work_item_type?: string;
        area_path?: string;
        iteration_path?: string;
        assigned_to?: string;
        auto_tags?: string[];
    };

    constructor(organization: string, project: string, defaults?: {
        work_item_type?: string;
        area_path?: string;
        iteration_path?: string;
        assigned_to?: string;
        auto_tags?: string[];
    }) {
        this.organization = organization;
        this.project = project;
        this.defaults = defaults;
    }

    async createWorkItem(
        title: string,
        body: string,
        labels?: string[],
        workItemType?: string,
        adoOptions?: AdoWorkItemOptions
    ): Promise<WorkItemResult> {
        const token = this.getToken();
        if (!token) {
            throw new Error('ADO PAT token not found in environment variables');
        }

        try {
            // Resolve values: call param > vcs.json default > fallback
            const resolvedType = workItemType || this.defaults?.work_item_type || 'User Story';
            const resolvedAreaPath = adoOptions?.area_path || this.defaults?.area_path;
            const resolvedIterationPath = adoOptions?.iteration_path || this.defaults?.iteration_path;
            const resolvedAssignedTo = adoOptions?.assigned_to || this.defaults?.assigned_to;
            const resolvedPriority = adoOptions?.priority;
            const resolvedParentId = adoOptions?.parent_id;

            // Convert Markdown body to HTML for ADO rich-text rendering
            const htmlBody = await marked.parse(body);

            // Merge tags: user labels + auto_tags from config (deduplicated)
            const autoTags = this.defaults?.auto_tags || [];
            const userTags = labels || [];
            const uniqueTags = [...new Set([...userTags, ...autoTags, 'optimus-bot'])];

            // Build JSON Patch document
            const patchDocument: Array<{op: string, path: string, value: any}> = [
                { op: 'add', path: '/fields/System.Title', value: title },
                { op: 'add', path: '/fields/System.Description', value: htmlBody }
            ];

            if (resolvedAreaPath) {
                patchDocument.push({ op: 'add', path: '/fields/System.AreaPath', value: resolvedAreaPath });
            }
            if (resolvedIterationPath) {
                patchDocument.push({ op: 'add', path: '/fields/System.IterationPath', value: resolvedIterationPath });
            }
            if (resolvedAssignedTo) {
                patchDocument.push({ op: 'add', path: '/fields/System.AssignedTo', value: resolvedAssignedTo });
            }
            if (resolvedPriority !== undefined) {
                patchDocument.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: resolvedPriority });
            }
            if (uniqueTags.length > 0) {
                patchDocument.push({ op: 'add', path: '/fields/System.Tags', value: uniqueTags.join('; ') });
            }

            // Parent hierarchy link
            if (resolvedParentId) {
                patchDocument.push({
                    op: 'add',
                    path: '/relations/-',
                    value: {
                        rel: 'System.LinkTypes.Hierarchy-Reverse',
                        url: `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workItems/${resolvedParentId}`,
                        attributes: { comment: 'Auto-linked by Optimus Swarm' }
                    }
                });
            }

            const response = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workitems/$${resolvedType}?api-version=7.0`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                        'Content-Type': 'application/json-patch+json',
                        'Accept': 'application/json',
                        'User-Agent': 'Optimus-Agent'
                    },
                    body: JSON.stringify(patchDocument)
                }
            );

            if (!response.ok) {
                throw new Error(`ADO API error: ${response.status} ${await response.text()}. Recovery hint: ${adoHttpRecoveryHint(response.status)}`);
            }

            const data = await response.json() as any;

            return {
                id: data.id.toString(),
                number: data.id,
                url: data._links.html.href,
                title: data.fields['System.Title']
            };
        } catch (error: any) {
            throw new Error(`Failed to create ADO work item: ${error.message}`);
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
            throw new Error('ADO PAT token not found in environment variables');
        }

        try {
            // First, we need to get the repository details
            const repoResponse = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
                {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                        'Accept': 'application/json',
                        'User-Agent': 'Optimus-Agent'
                    }
                }
            );

            if (!repoResponse.ok) {
                throw new Error(`Failed to get repository info: ${repoResponse.status}`);
            }

            const repos = await repoResponse.json() as any;
            if (!repos.value || repos.value.length === 0) {
                throw new Error('No repositories found in the project');
            }

            // Use the first repository (common for single-repo projects)
            const repositoryId = repos.value[0].id;

            const pullRequestData = {
                sourceRefName: `refs/heads/${head}`,
                targetRefName: `refs/heads/${base}`,
                title,
                description: body || '',
                reviewers: []
            };

            const response = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests?api-version=7.0`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'Optimus-Agent'
                    },
                    body: JSON.stringify(pullRequestData)
                }
            );

            if (!response.ok) {
                throw new Error(`ADO API error: ${response.status} ${await response.text()}. Recovery hint: ${adoHttpRecoveryHint(response.status)}`);
            }

            const data = await response.json() as any;

            return {
                id: data.pullRequestId.toString(),
                number: data.pullRequestId,
                url: data._links.web.href,
                title: data.title
            };
        } catch (error: any) {
            throw new Error(`Failed to create ADO pull request: ${error.message}`);
        }
    }

    async mergePullRequest(
        pullRequestId: string | number,
        commitTitle?: string,
        mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'
    ): Promise<MergeResult> {
        const token = this.getToken();
        if (!token) {
            throw new Error('ADO PAT token not found in environment variables');
        }

        try {
            // First get repository info to get the repository ID
            const repoResponse = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
                {
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                        'Accept': 'application/json',
                        'User-Agent': 'Optimus-Agent'
                    }
                }
            );

            if (!repoResponse.ok) {
                console.error("[mergePullRequest] ADO repo-list request failed with status " + repoResponse.status + ". " + adoHttpRecoveryHint(repoResponse.status));
                return { merged: false };
            }

            const repos = await repoResponse.json() as any;
            if (!repos.value || repos.value.length === 0) {
                console.error("[mergePullRequest] No repositories found in project. Verify org/project in .optimus/config/vcs.json.");
                return { merged: false };
            }

            const repositoryId = repos.value[0].id;
            const prId = typeof pullRequestId === 'string' ? parseInt(pullRequestId) : pullRequestId;

            // Fetch PR data to get source/target branch names
            let headBranch: string | undefined;
            let baseBranch: string | undefined;
            try {
                const prResponse = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests/${prId}?api-version=7.0`,
                    {
                        headers: {
                            'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                            'Accept': 'application/json',
                            'User-Agent': 'Optimus-Agent'
                        }
                    }
                );
                if (prResponse.ok) {
                    const prData = await prResponse.json() as any;
                    headBranch = prData.sourceRefName?.replace('refs/heads/', '');
                    baseBranch = prData.targetRefName?.replace('refs/heads/', '');
                }
            } catch (e: any) {
                console.error("[mergePullRequest] Warning: failed to fetch PR branch names:", e.message);
                // Best-effort: continue with merge even if branch name fetch fails
            }

            // ADO merge requires updating the PR status to 'completed'
            const mergeData: any = {
                status: 'completed',
                completionOptions: {
                    mergeStrategy: mergeMethod === 'squash' ? 'squashMerge' : 'noFastForward',
                    deleteSourceBranch: true
                }
            };

            if (commitTitle) {
                mergeData.completionOptions.mergeCommitMessage = commitTitle;
            }

            const response = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests/${prId}?api-version=7.0`,
                {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'Optimus-Agent'
                    },
                    body: JSON.stringify(mergeData)
                }
            );

            return { merged: response.ok, headBranch, baseBranch };
        } catch (e: any) {
            console.error("[mergePullRequest] Merge failed:", e.message);
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
            throw new Error('ADO PAT token not found in environment variables');
        }

        const id = typeof itemId === 'string' ? parseInt(itemId) : itemId;

        try {
            if (itemType === 'workitem') {
                // Add comment to work item
                const response = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workItems/${id}/comments?api-version=7.0-preview.3`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'User-Agent': 'Optimus-Agent'
                        },
                        body: JSON.stringify({ text: comment })
                    }
                );

                if (!response.ok) {
                    throw new Error(`ADO API error: ${response.status} ${await response.text()}. Recovery hint: ${adoHttpRecoveryHint(response.status)}`);
                }

                const data = await response.json() as any;

                return {
                    id: data.id.toString(),
                    url: data.url || `https://dev.azure.com/${this.organization}/${this.project}/_workitems/edit/${id}`
                };
            } else {
                // Add comment to pull request - need repository ID
                const repoResponse = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
                    {
                        headers: {
                            'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                            'Accept': 'application/json',
                            'User-Agent': 'Optimus-Agent'
                        }
                    }
                );

                if (!repoResponse.ok) {
                    throw new Error('Failed to get repository info');
                }

                const repos = await repoResponse.json() as any;
                const repositoryId = repos.value[0].id;

                const response = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullRequests/${id}/threads?api-version=7.0`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'User-Agent': 'Optimus-Agent'
                        },
                        body: JSON.stringify({
                            comments: [{
                                parentCommentId: 0,
                                content: comment,
                                commentType: 'text'
                            }],
                            status: 'active'
                        })
                    }
                );

                if (!response.ok) {
                    throw new Error(`ADO API error: ${response.status} ${await response.text()}. Recovery hint: ${adoHttpRecoveryHint(response.status)}`);
                }

                const data = await response.json() as any;

                return {
                    id: data.id.toString(),
                    url: `https://dev.azure.com/${this.organization}/${this.project}/_git/pullrequest/${id}`
                };
            }
        } catch (error: any) {
            throw new Error(`Failed to add ADO comment: ${error.message}`);
        }
    }

    getProviderName(): string {
        return 'azure-devops';
    }

    private getToken(): string | undefined {
        return process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT;
    }
}