import { IVcsProvider, WorkItemResult, PullRequestResult, CommentResult } from './IVcsProvider';

/**
 * Azure DevOps VCS Provider Implementation
 *
 * Implements the unified VCS interface using Azure DevOps REST API.
 * Uses Personal Access Tokens (PATs) for authentication.
 */
export class AdoProvider implements IVcsProvider {
    private organization: string;
    private project: string;

    constructor(organization: string, project: string) {
        this.organization = organization;
        this.project = project;
    }

    async createWorkItem(
        title: string,
        body: string,
        labels?: string[],
        workItemType: string = 'User Story'
    ): Promise<WorkItemResult> {
        const token = this.getToken();
        if (!token) {
            throw new Error('ADO PAT token not found in environment variables');
        }

        try {
            // ADO Work Items API uses PATCH with JSON Patch format
            const patchDocument = [
                {
                    op: 'add',
                    path: '/fields/System.Title',
                    value: title
                },
                {
                    op: 'add',
                    path: '/fields/System.Description',
                    value: body
                }
            ];

            // Add tags if provided (ADO uses semicolon-separated tags)
            if (labels && labels.length > 0) {
                patchDocument.push({
                    op: 'add',
                    path: '/fields/System.Tags',
                    value: labels.join(';')
                });
            }

            const response = await fetch(
                `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workitems/$${workItemType}?api-version=7.0`,
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
                throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
            }

            const data = await response.json() as any;

            return {
                id: data.id.toString(),
                number: data.id, // ADO uses ID as the work item number
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
                throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
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
        mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'
    ): Promise<boolean> {
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
                return false;
            }

            const repos = await repoResponse.json() as any;
            if (!repos.value || repos.value.length === 0) {
                return false;
            }

            const repositoryId = repos.value[0].id;
            const prId = typeof pullRequestId === 'string' ? parseInt(pullRequestId) : pullRequestId;

            // ADO merge requires updating the PR status to 'completed'
            const mergeData = {
                status: 'completed',
                completionOptions: {
                    mergeStrategy: mergeMethod === 'squash' ? 'squashMerge' : 'noFastForward',
                    deleteSourceBranch: false
                }
            };

            if (commitTitle) {
                mergeData.completionOptions['mergeCommitMessage'] = commitTitle;
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
            throw new Error('ADO PAT token not found in environment variables');
        }

        const id = typeof itemId === 'string' ? parseInt(itemId) : itemId;

        try {
            if (itemType === 'workitem') {
                // Add comment to work item
                const response = await fetch(
                    `https://dev.azure.com/${this.organization}/${this.project}/_apis/wit/workItems/${id}/comments?api-version=7.0`,
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
                    throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
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
                    throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
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