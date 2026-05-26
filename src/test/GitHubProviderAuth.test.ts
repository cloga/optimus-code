import { afterEach, describe, expect, it } from 'vitest';
import { GitHubProvider } from '../adapters/vcs/GitHubProvider';

type SeenRequest = {
    url: string;
    init?: RequestInit;
};

const originalFetch = globalThis.fetch;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;

function restoreEnv(): void {
    if (originalGitHubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
    } else {
        process.env.GITHUB_TOKEN = originalGitHubToken;
    }
    if (originalGhToken === undefined) {
        delete process.env.GH_TOKEN;
    } else {
        process.env.GH_TOKEN = originalGhToken;
    }
}

function createFetchMock(seenRequests: SeenRequest[]) {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        seenRequests.push({ url: String(input), init });
        return {
            ok: true,
            status: 201,
            json: async () => ({
                id: 123,
                number: 456,
                html_url: 'https://github.com/cloga/optimus-code/issues/456',
                title: '[Optimus] Created issue',
            }),
            text: async () => '{}',
        } as Response;
    };
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
});

describe('GitHubProvider authentication', () => {
    it('uses the configured env:GITHUB_TOKEN even when GH_TOKEN is also set', async () => {
        process.env.GITHUB_TOKEN = 'configured-token';
        process.env.GH_TOKEN = 'wrong-gh-token';
        const seenRequests: SeenRequest[] = [];
        globalThis.fetch = createFetchMock(seenRequests) as typeof fetch;

        const provider = new GitHubProvider('cloga', 'optimus-code', 'env:GITHUB_TOKEN');
        await provider.createWorkItem('Created issue', 'Body');

        expect((seenRequests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer configured-token');
    });

    it('does not fall back to GH_TOKEN when configured auth env is missing', async () => {
        delete process.env.GITHUB_TOKEN;
        process.env.GH_TOKEN = 'wrong-gh-token';
        const provider = new GitHubProvider('cloga', 'optimus-code', 'env:GITHUB_TOKEN');

        await expect(provider.createWorkItem('Created issue', 'Body'))
            .rejects.toThrow(/Configured GitHub auth environment variable 'GITHUB_TOKEN' is not set/);
    });

    it('preserves legacy fallback when no auth mode is configured', async () => {
        delete process.env.GITHUB_TOKEN;
        process.env.GH_TOKEN = 'legacy-gh-token';
        const seenRequests: SeenRequest[] = [];
        globalThis.fetch = createFetchMock(seenRequests) as typeof fetch;

        const provider = new GitHubProvider('cloga', 'optimus-code');
        await provider.createWorkItem('Created issue', 'Body');

        expect((seenRequests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer legacy-gh-token');
    });
});
