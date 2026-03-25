import { IVcsProvider, WorkItemResult, WorkItemListItem, PullRequestListItem, PullRequestResult, CommentResult, MergeResult, AdoWorkItemOptions, VcsComment, WorkItemUpdate } from './IVcsProvider';
import { marked } from 'marked';
import * as childProcess from 'child_process';

/**
 * Azure DevOps VCS Provider Implementation
 *
 * Implements the unified VCS interface using Azure DevOps REST API.
 * Uses Personal Access Tokens (PATs) or Azure CLI access tokens for authentication.
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

function isGuidLike(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

export class AdoProvider implements IVcsProvider {
    private readonly azCliTokenProvider: () => string | undefined;
    private authMode?: string;
    private organization: string;
    private project: string;
    private webBaseUrl: string;
    private projectDisplayName?: string;
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
    }, webBaseUrl?: string, authMode?: string, azCliTokenProvider?: () => string | undefined) {
        this.organization = organization;
        this.project = project;
        this.defaults = defaults;
        this.webBaseUrl = trimTrailingSlash(webBaseUrl || `https://${organization}.visualstudio.com`);
        this.authMode = authMode;
        this.azCliTokenProvider = azCliTokenProvider || (() => {
            return childProcess.execSync(
                'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv',
                {
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe']
                }
            ).trim();
        });
    }

    private getMissingTokenError(): Error {
        return new Error('ADO authentication token not found. Set ADO_PAT or AZURE_DEVOPS_PAT, or configure ado.auth = "az-cli" and ensure `az login` has an active session.');
    }

    private getAuthCredential(): { authorization: string } | undefined {
        const envToken = process.env.ADO_PAT || process.env.AZURE_DEVOPS_PAT;
        if (envToken) {
            return {
                authorization: `Basic ${Buffer.from(`:${envToken}`).toString('base64')}`
            };
        }

        if (this.authMode === 'az-cli') {
            try {
                const accessToken = this.azCliTokenProvider();

                if (accessToken) {
                    return {
                        authorization: `Bearer ${accessToken}`
                    };
                }
            } catch (error: any) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[AdoProvider] az-cli token acquisition failed: ${message}`);
                return undefined;
            }
        }

        return undefined;
    }

    private async resolveProjectDisplayName(): Promise<string> {
        if (this.projectDisplayName) {
            return this.projectDisplayName;
        }

        if (!isGuidLike(this.project)) {
            this.projectDisplayName = this.project;
            return this.projectDisplayName;
        }

        const authCredential = this.getAuthCredential();
        if (!authCredential) {
            this.projectDisplayName = this.project;
            return this.projectDisplayName;
        }

        try {
            const response = await fetch(
                `https://dev.azure.com/${this.organization}/_apis/projects/${this.project}?api-version=7.0`,
                {
                    headers: {
                        'Authorization': authCredential.authorization,
                        'Accept': 'application/json',
                        'User-Agent': 'Optimus-Agent'
                    }
                }
            );

            if (response.ok) {
                const data = await response.json() as any;
                if (typeof data?.name === 'string' && data.name.trim().length > 0) {
                    const displayName = data.name.trim();
                    this.projectDisplayName = displayName;
                    return displayName;
                }
            } else {
                console.error(`[AdoProvider] Project metadata lookup failed (${response.status}). Falling back to configured project identifier.`);
            }
        } catch (error: any) {
            console.error(`[AdoProvider] Project metadata lookup failed: ${error.message}`);
        }

        this.projectDisplayName = this.project;
        return this.projectDisplayName;
    }

    private async buildWorkItemUiUrl(workItemId: string | number, commentId?: string | number): Promise<string> {
        const projectDisplayName = await this.resolveProjectDisplayName();
        const baseUrl = `${this.webBaseUrl}/${encodeURIComponent(projectDisplayName)}/_workitems/edit/${workItemId}`;
        return commentId === undefined ? baseUrl : `${baseUrl}#${commentId}`;
    }

    private buildAdoAuthHeaders(contentType?: string): Record<string, string> {
        const authCredential = this.getAuthCredential();
        if (!authCredential) {
            throw this.getMissingTokenError();
        }

        return {
            'Authorization': authCredential.authorization,
            ...(contentType ? { 'Content-Type': contentType } : {}),
            'Accept': 'application/json',
            'User-Agent': 'Optimus-Agent'
        };
    }

    async createWorkItem(
        title: string,
        body: string,
        labels?: string[],
        workItemType?: string,
        adoOptions?: AdoWorkItemOptions
    ): Promise<WorkItemResult> {
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
                    headers: this.buildAdoAuthHeaders('application/json-patch+json'),
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
                url: await this.buildWorkItemUiUrl(data.id),
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
        try {
            // First, we need to get the repository details
            const repoResponse = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
                {
                    headers: this.buildAdoAuthHeaders()
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
                    headers: this.buildAdoAuthHeaders('application/json'),
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
        try {
            // First get repository info to get the repository ID
            const repoResponse = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
                {
                    headers: this.buildAdoAuthHeaders()
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
                        headers: this.buildAdoAuthHeaders()
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
                    headers: this.buildAdoAuthHeaders('application/json'),
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
        const id = typeof itemId === 'string' ? parseInt(itemId) : itemId;

        try {
            if (itemType === 'workitem') {
                // Add comment to work item — convert Markdown to HTML for ADO rendering
                const htmlComment = await marked.parse(comment);
                const response = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workItems/${id}/comments?api-version=7.0-preview.3`,
                    {
                        method: 'POST',
                        headers: this.buildAdoAuthHeaders('application/json'),
                        body: JSON.stringify({ text: htmlComment })
                    }
                );

                if (!response.ok) {
                    throw new Error(`ADO API error: ${response.status} ${await response.text()}. Recovery hint: ${adoHttpRecoveryHint(response.status)}`);
                }

                const data = await response.json() as any;

                return {
                    id: data.id.toString(),
                    url: await this.buildWorkItemUiUrl(id, data.id)
                };
            } else {
                // Add comment to pull request - need repository ID
                const repoResponse = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories?api-version=7.0`,
                    {
                        headers: this.buildAdoAuthHeaders()
                    }
                );

                if (!repoResponse.ok) {
                    throw new Error('Failed to get repository info');
                }

                const repos = await repoResponse.json() as any;
                const repositoryId = repos.value[0].id;

                const htmlPrComment = await marked.parse(comment);
                const response = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/git/repositories/${repositoryId}/pullRequests/${id}/threads?api-version=7.0`,
                    {
                        method: 'POST',
                        headers: this.buildAdoAuthHeaders('application/json'),
                        body: JSON.stringify({
                            comments: [{
                                parentCommentId: 0,
                                content: htmlPrComment,
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

    async getComments(
        _itemType: 'workitem' | 'pullrequest',
        _itemId: string | number,
        _since?: string
    ): Promise<VcsComment[]> {
        console.error('[AdoProvider] getComments() is not yet implemented for Azure DevOps. Returning empty array.');
        return [];
    }

    async addLabels(
        _itemType: 'workitem' | 'pullrequest',
        _itemId: string | number,
        _labels: string[]
    ): Promise<void> {
        console.error('[AdoProvider] addLabels() is not yet implemented for Azure DevOps.');
        return Promise.resolve();
    }

    getProviderName(): string {
        return 'azure-devops';
    }

    async updateWorkItem(
        itemId: string | number,
        updates: WorkItemUpdate
    ): Promise<WorkItemResult> {
        const id = typeof itemId === 'string' ? parseInt(itemId, 10) : itemId;
        if (!Number.isFinite(id)) {
            throw new Error(`Invalid ADO work item id '${itemId}'.`);
        }

        const patchDocument: Array<{ op: 'add'; path: string; value: string | number }> = [];
        if (updates.title !== undefined) {
            patchDocument.push({ op: 'add', path: '/fields/System.Title', value: updates.title });
        }
        if (updates.description !== undefined) {
            patchDocument.push({ op: 'add', path: '/fields/System.Description', value: await marked.parse(updates.description) });
        }
        if (updates.state !== undefined) {
            patchDocument.push({ op: 'add', path: '/fields/System.State', value: updates.state });
        }
        if (updates.assigned_to !== undefined) {
            patchDocument.push({ op: 'add', path: '/fields/System.AssignedTo', value: updates.assigned_to });
        }
        if (updates.priority !== undefined) {
            patchDocument.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: updates.priority });
        }

        if (patchDocument.length === 0) {
            throw new Error('ADO updateWorkItem requires at least one of: title, description, state, assigned_to, priority.');
        }

        try {
            const response = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workitems/${id}?api-version=7.0`,
                {
                    method: 'PATCH',
                    headers: this.buildAdoAuthHeaders('application/json-patch+json'),
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
                url: await this.buildWorkItemUiUrl(data.id),
                title: data.fields?.['System.Title'] || updates.title || `Work item ${id}`
            };
        } catch (error: any) {
            throw new Error(`Failed to update ADO work item: ${error.message}`);
        }
    }

    async listWorkItems(
        _filters?: { state?: 'open' | 'closed' | 'all'; labels?: string[]; limit?: number }
    ): Promise<WorkItemListItem[]> {
        console.error('[AdoProvider] listWorkItems() is not yet implemented for Azure DevOps. Returning empty array.');
        return [];
    }

    async listPullRequests(
        _filters?: { state?: 'open' | 'closed' | 'all'; limit?: number }
    ): Promise<PullRequestListItem[]> {
        console.error('[AdoProvider] listPullRequests() is not yet implemented for Azure DevOps. Returning empty array.');
        return [];
    }

}
