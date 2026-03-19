import { afterEach, describe, expect, it } from 'vitest';
import { AdoProvider } from '../adapters/vcs/AdoProvider';

type MockFetchResponse = {
    ok: boolean;
    status?: number;
    jsonBody?: any;
    textBody?: string;
};

function createFetchMock(queue: MockFetchResponse[], seenUrls: string[]) {
    return async (input: string | URL | Request): Promise<Response> => {
        seenUrls.push(String(input));
        const next = queue.shift();
        if (!next) {
            throw new Error(`Unexpected fetch call for ${String(input)}`);
        }

        return {
            ok: next.ok,
            status: next.status ?? (next.ok ? 200 : 500),
            json: async () => next.jsonBody,
            text: async () => next.textBody ?? JSON.stringify(next.jsonBody ?? {})
        } as Response;
    };
}

const originalFetch = globalThis.fetch;
const originalPat = process.env.ADO_PAT;

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalPat === undefined) {
        delete process.env.ADO_PAT;
    } else {
        process.env.ADO_PAT = originalPat;
    }
});

describe('AdoProvider URL generation', () => {
    it('returns an encoded browser URL for created work items', async () => {
        process.env.ADO_PAT = 'test-pat';
        const seenUrls: string[] = [];
        globalThis.fetch = createFetchMock([
            {
                ok: true,
                jsonBody: {
                    id: 321,
                    fields: { 'System.Title': 'Created item' },
                    _links: { html: { href: 'https://dev.azure.com/o365exchange/O365%20Core/_apis/wit/workitems/321' } }
                }
            }
        ], seenUrls) as typeof fetch;

        const provider = new AdoProvider('o365exchange', 'O365 Core', undefined, 'https://o365exchange.visualstudio.com');
        const result = await provider.createWorkItem('Created item', 'Body');

        expect(result.url).toBe('https://o365exchange.visualstudio.com/O365%20Core/_workitems/edit/321');
        expect(seenUrls).toHaveLength(1);
    });

    it('returns an anchored browser URL for work item comments', async () => {
        process.env.ADO_PAT = 'test-pat';
        const seenUrls: string[] = [];
        globalThis.fetch = createFetchMock([
            {
                ok: true,
                jsonBody: {
                    id: 987,
                    url: 'https://dev.azure.com/o365exchange/7c6cf0e2-4ea2-44d0-8a12-11f74b125ccc/_apis/wit/workItems/321/comments/987'
                }
            }
        ], seenUrls) as typeof fetch;

        const provider = new AdoProvider('o365exchange', 'O365 Core', undefined, 'https://o365exchange.visualstudio.com');
        const result = await provider.addComment('workitem', 321, 'hello');

        expect(result.url).toBe('https://o365exchange.visualstudio.com/O365%20Core/_workitems/edit/321#987');
        expect(seenUrls).toHaveLength(1);
    });

    it('resolves GUID project identifiers to the display name before building URLs', async () => {
        process.env.ADO_PAT = 'test-pat';
        const seenUrls: string[] = [];
        const projectId = '7c6cf0e2-4ea2-44d0-8a12-11f74b125ccc';
        globalThis.fetch = createFetchMock([
            {
                ok: true,
                jsonBody: {
                    id: 654,
                    fields: { 'System.Title': 'Guid-backed project' },
                    _links: { html: { href: `https://dev.azure.com/o365exchange/${projectId}/_apis/wit/workitems/654` } }
                }
            },
            {
                ok: true,
                jsonBody: {
                    name: 'O365 Core'
                }
            }
        ], seenUrls) as typeof fetch;

        const provider = new AdoProvider('o365exchange', projectId, undefined, 'https://o365exchange.visualstudio.com');
        const result = await provider.createWorkItem('Guid-backed project', 'Body');

        expect(result.url).toBe('https://o365exchange.visualstudio.com/O365%20Core/_workitems/edit/654');
        expect(seenUrls[1]).toBe(`https://dev.azure.com/o365exchange/_apis/projects/${projectId}?api-version=7.0`);
    });
});