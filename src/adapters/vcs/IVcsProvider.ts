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
     * @returns Promise with created work item details
     */
    createWorkItem(
        title: string,
        body: string,
        labels?: string[],
        workItemType?: string
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
    ): Promise<boolean>;

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
     * Get provider name for diagnostics
     */
    getProviderName(): string;
}