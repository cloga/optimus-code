import { execSync } from 'child_process';

interface GitHubIssueResult {
    number: number;
    html_url: string;
}

function getToken(): string | undefined {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

export function parseGitRemote(workspacePath: string): { owner: string; repo: string } | null {
    try {
        const url = execSync('git remote get-url origin', { cwd: workspacePath, encoding: 'utf8' }).trim();
        // https://github.com/owner/repo or git@github.com:owner/repo.git
        const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
        if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
        const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
        if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
        return null;
    } catch {
        return null;
    }
}

export async function createGitHubIssue(
    owner: string, repo: string, title: string, body: string, labels: string[]
): Promise<GitHubIssueResult | null> {
    const token = getToken();
    if (!token) return null;

    // Defense-in-depth: ensure optimus-bot label is always present
    const issueLabels = Array.isArray(labels) ? [...labels] : [];
    if (!issueLabels.includes('optimus-bot')) {
        issueLabels.push('optimus-bot');
    }

    try {
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify({ title, body, labels: issueLabels })
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '(unreadable)');
            console.error(`[githubApi] createGitHubIssue failed: ${resp.status} ${errText}`);
            return null;
        }
        const data: any = await resp.json();
        return { number: data.number, html_url: data.html_url };
    } catch (err: any) {
        console.error(`[githubApi] createGitHubIssue exception: ${err.message}`);
        return null;
    }
}

export async function commentOnGitHubIssue(
    owner: string, repo: string, issueNumber: number, body: string
): Promise<boolean> {
    const token = getToken();
    if (!token) return false;

    try {
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify({ body })
        });
        return resp.ok;
    } catch {
        return false;
    }
}

export async function closeGitHubIssue(
    owner: string, repo: string, issueNumber: number
): Promise<boolean> {
    const token = getToken();
    if (!token) return false;

    try {
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
            method: "PATCH",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify({ state: "closed" })
        });
        return resp.ok;
    } catch {
        return false;
    }
}

export interface GitHubCommentResult {
    id: number;
    author: string;
    author_association: string;
    body: string;
    created_at: string;
}

export async function getIssueComments(
    owner: string, repo: string, issueNumber: number, since?: string
): Promise<GitHubCommentResult[]> {
    const token = getToken();
    if (!token) return [];

    try {
        let url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
        if (since) {
            url += `?since=${encodeURIComponent(since)}`;
        }

        const resp = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Optimus-Agent"
            }
        });

        if (!resp.ok) {
            console.error(`[githubApi] getIssueComments failed: ${resp.status}`);
            return [];
        }

        const data: any[] = await resp.json() as any[];
        return data.map((c: any) => ({
            id: c.id,
            author: c.user?.login || 'unknown',
            author_association: c.author_association || '',
            body: c.body || '',
            created_at: c.created_at
        }));
    } catch (err: any) {
        console.error(`[githubApi] getIssueComments exception: ${err.message}`);
        return [];
    }
}
