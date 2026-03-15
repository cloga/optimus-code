/**
 * Unified VCS Provider Interface
 *
 * Strategy Pattern: Common interface for all version control system providers.
 * Enables platform-agnostic operations across GitHub, Azure DevOps, etc.
 */

export interface WorkItemResult {
    id: string;
    number?: number;
    url: string;
    title: string;
}

export interface PullRequestResult {
    id: string;
    number: number;
    url: string;
    title: string;
}

export interface CommentResult {
    id: string;
    url: string;
}

export interface VcsComment {
    id: number | string;
    author: string;
    author_association?: string;
    body: string;
    created_at: string;
}

export interface MergeResult {
    merged: boolean;
    headBranch?: string;  // source branch name (for local cleanup)
    baseBranch?: string;  // target branch name
}

export interface WorkItemListItem {
    id: string;
    number?: number;
    title: string;
    state: string;
    labels: string[];
    url: string;
    created_at: string;
    updated_at: string;
}

export interface PullRequestListItem {
    id: string;
    number: number;
    title: string;
    state: string;
    mergeable: string;
    headBranch: string;
    baseBranch: string;
    labels: string[];
    url: string;
    created_at: string;
    updated_at: string;
}

export interface AdoWorkItemOptions {
    iteration_path?: string;
    area_path?: string;
    assigned_to?: string;
    parent_id?: number;
    priority?: number;
}

/**
 * Unified VCS Provider Interface
 *
 * This interface abstracts the differences between GitHub Issues/PRs and
 * Azure DevOps Work Items/Pull Requests into a consistent API.
 */
export interface IVcsProvider {
    /**
     * Create a work item (GitHub Issue or ADO Work Item)
     *
     * @param title - Work item title
     * @param body - Work item description/body
     * @param labels - Labels/tags to apply
     * @param workItemType - ADO-specific work item type (Bug, User Story, Task). Ignored by GitHub.
     * @param adoOptions - ADO-specific options (iteration, area, assigned_to, parent, priority). Ignored by GitHub.
     * @returns Promise with created work item details
     */
    createWorkItem(
        title: string,
        body: string,
        labels?: string[],
        workItemType?: string,
        adoOptions?: AdoWorkItemOptions
    ): Promise<WorkItemResult>;

    /**
     * Create a pull request
     *
     * @param title - PR title
     * @param body - PR description
     * @param head - Source branch
     * @param base - Target branch
     * @returns Promise with created PR details
     */
    createPullRequest(
        title: string,
        body: string,
        head: string,
        base: string
    ): Promise<PullRequestResult>;

    /**
     * Merge a pull request
     *
     * @param pullRequestId - PR ID or number
     * @param commitTitle - Merge commit title
     * @param mergeMethod - Merge strategy (merge, squash, rebase)
     * @returns Promise with merge result
     */
    mergePullRequest(
        pullRequestId: string | number,
        commitTitle?: string,
        mergeMethod?: 'merge' | 'squash' | 'rebase'
    ): Promise<MergeResult>;

    /**
     * Add a comment to a work item or pull request
     *
     * @param itemType - Type of item ('workitem' or 'pullrequest')
     * @param itemId - Work item or PR ID/number
     * @param comment - Comment text
     * @returns Promise with comment details
     */
    addComment(
        itemType: 'workitem' | 'pullrequest',
        itemId: string | number,
        comment: string
    ): Promise<CommentResult>;

    /**
     * Get comments on a work item or pull request
     *
     * @param itemType - Type of item ('workitem' or 'pullrequest')
     * @param itemId - Work item or PR ID/number
     * @param since - Optional ISO timestamp to filter comments created after this time
     * @returns Promise with array of comments
     */
    getComments(
        itemType: 'workitem' | 'pullrequest',
        itemId: string | number,
        since?: string
    ): Promise<VcsComment[]>;

    /**
     * Add labels to a work item or pull request
     *
     * @param itemType - Type of item ('workitem' or 'pullrequest')
     * @param itemId - Work item or PR ID/number
     * @param labels - Array of label strings to add
     * @returns Promise resolving when labels are added
     */
    addLabels(
        itemType: 'workitem' | 'pullrequest',
        itemId: string | number,
        labels: string[]
    ): Promise<void>;

    /**
     * Update a work item (change state, title, labels, etc.)
     */
    updateWorkItem(
        itemId: string | number,
        updates: { state?: 'open' | 'closed'; title?: string; labels_add?: string[]; labels_remove?: string[] }
    ): Promise<WorkItemResult>;

    /**
     * List work items (issues) matching filters
     */
    listWorkItems(
        filters?: { state?: 'open' | 'closed' | 'all'; labels?: string[]; limit?: number }
    ): Promise<WorkItemListItem[]>;

    /**
     * List pull requests matching filters
     */
    listPullRequests(
        filters?: { state?: 'open' | 'closed' | 'all'; limit?: number }
    ): Promise<PullRequestListItem[]>;

    /**
     * Get provider name for diagnostics
     */
    getProviderName(): string;
}