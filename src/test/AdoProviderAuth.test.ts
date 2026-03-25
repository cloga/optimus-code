import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdoProvider } from '../adapters/vcs/AdoProvider';

type SeenRequest = {
    url: string;
    init?: RequestInit;
};

function createFetchMockWithRequests(seenRequests: SeenRequest[]) {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        seenRequests.push({ url: String(input), init });
        return {
            ok: true,
            status: 200,
            json: async () => ({
                id: 321,
                fields: { 'System.Title': 'Created item' }
            }),
            text: async () => '{}'
        } as Response;
    };
}

const originalFetch = globalThis.fetch;
const originalAdoPat = process.env.ADO_PAT;
const originalAzureDevopsPat = process.env.AZURE_DEVOPS_PAT;

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalAdoPat === undefined) {
        delete process.env.ADO_PAT;
    } else {
        process.env.ADO_PAT = originalAdoPat;
    }
    if (originalAzureDevopsPat === undefined) {
        delete process.env.AZURE_DEVOPS_PAT;
    } else {
        process.env.AZURE_DEVOPS_PAT = originalAzureDevopsPat;
    }
});

describe('AdoProvider authentication', () => {
    it('uses Azure CLI access token as a Bearer token when ado auth mode is az-cli', async () => {
        delete process.env.ADO_PAT;
        delete process.env.AZURE_DEVOPS_PAT;

        const azCliTokenProvider = vi.fn(() => 'az-access-token');
        const seenRequests: SeenRequest[] = [];
        globalThis.fetch = createFetchMockWithRequests(seenRequests) as typeof fetch;

        const provider = new AdoProvider('o365exchange', 'O365 Core', undefined, 'https://o365exchange.visualstudio.com', 'az-cli', azCliTokenProvider);
        await provider.createWorkItem('Created item', 'Body');

        expect(azCliTokenProvider).toHaveBeenCalledTimes(1);
        expect((seenRequests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer az-access-token');
    });

    it('prefers PAT environment variables over Azure CLI fallback', async () => {
        process.env.ADO_PAT = 'env-pat';
        delete process.env.AZURE_DEVOPS_PAT;

        const azCliTokenProvider = vi.fn(() => 'az-access-token');
        const seenRequests: SeenRequest[] = [];
        globalThis.fetch = createFetchMockWithRequests(seenRequests) as typeof fetch;

        const provider = new AdoProvider('o365exchange', 'O365 Core', undefined, 'https://o365exchange.visualstudio.com', 'az-cli', azCliTokenProvider);
        await provider.createWorkItem('Created item', 'Body');

        expect(azCliTokenProvider).not.toHaveBeenCalled();
        expect((seenRequests[0].init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(':env-pat').toString('base64')}`);
    });
});
