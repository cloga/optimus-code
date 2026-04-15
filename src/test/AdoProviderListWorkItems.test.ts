import { afterEach, describe, expect, it } from 'vitest';
import { AdoProvider } from '../adapters/vcs/AdoProvider';

type MockFetchResponse = {
    ok: boolean;
    status?: number;
    jsonBody?: any;
    textBody?: string;
};

type SeenRequest = {
    url: string;
    init?: RequestInit;
};

function createFetchMock(queue: MockFetchResponse[], seenRequests: SeenRequest[]) {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        seenRequests.push({ url: String(input), init });
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

describe('AdoProvider listWorkItems', () => {
    it('queries WIQL and maps returned work items into the shared list shape', async () => {
        process.env.ADO_PAT = 'test-pat';
        const seenRequests: SeenRequest[] = [];
        globalThis.fetch = createFetchMock([
            {
                ok: true,
                jsonBody: {
                    workItems: [{ id: 321 }, { id: 654 }]
                }
            },
            {
                ok: true,
                jsonBody: {
                    value: [
                        {
                            id: 321,
                            fields: {
                                'System.Title': 'First item',
                                'System.State': 'Active',
                                'System.Tags': 'FlightReview; optimus-bot',
                                'System.CreatedDate': '2026-04-01T00:00:00Z',
                                'System.ChangedDate': '2026-04-02T00:00:00Z'
                            }
                        },
                        {
                            id: 654,
                            fields: {
                                'System.Title': 'Second item',
                                'System.State': 'New',
                                'System.Tags': '',
                                'System.CreatedDate': '2026-04-03T00:00:00Z',
                                'System.ChangedDate': '2026-04-04T00:00:00Z'
                            }
                        }
                    ]
                }
            }
        ], seenRequests) as typeof fetch;

        const provider = new AdoProvider('o365exchange', 'O365 Core', undefined, 'https://o365exchange.visualstudio.com');
        const items = await provider.listWorkItems({ state: 'open', labels: ['FlightReview'], limit: 2 });

        expect(seenRequests).toHaveLength(2);
        expect(seenRequests[0].url).toBe('https://dev.azure.com/o365exchange/O365 Core/_apis/wit/wiql?$top=50&api-version=7.0');
        expect(seenRequests[0].init?.method).toBe('POST');

        const wiqlBody = JSON.parse(seenRequests[0].init?.body as string);
        expect(wiqlBody.query).toContain('SELECT [System.Id] FROM WorkItems');
        expect(wiqlBody.query).toContain("[System.Tags] CONTAINS 'FlightReview'");

        expect(seenRequests[1].url).toBe('https://dev.azure.com/o365exchange/O365 Core/_apis/wit/workitemsbatch?api-version=7.0');
        expect(seenRequests[1].init?.method).toBe('POST');
        const batchBody = JSON.parse(seenRequests[1].init?.body as string);
        expect(batchBody.ids).toEqual([321, 654]);
        expect(batchBody.fields).toContain('System.Title');
        expect(batchBody.errorPolicy).toBe('Omit');

        expect(items).toEqual([
            {
                id: '321',
                number: 321,
                title: 'First item',
                state: 'Active',
                labels: ['FlightReview', 'optimus-bot'],
                url: 'https://o365exchange.visualstudio.com/O365%20Core/_workitems/edit/321',
                created_at: '2026-04-01T00:00:00Z',
                updated_at: '2026-04-02T00:00:00Z'
            }
        ]);
    });

    it('returns an empty array when WIQL finds no work items', async () => {
        process.env.ADO_PAT = 'test-pat';
        const seenRequests: SeenRequest[] = [];
        globalThis.fetch = createFetchMock([
            {
                ok: true,
                jsonBody: {
                    workItems: []
                }
            }
        ], seenRequests) as typeof fetch;

        const provider = new AdoProvider('o365exchange', 'O365 Core', undefined, 'https://o365exchange.visualstudio.com');
        const items = await provider.listWorkItems({ state: 'closed', limit: 5 });

        expect(items).toEqual([]);
        expect(seenRequests).toHaveLength(1);
        const wiqlBody = JSON.parse(seenRequests[0].init?.body as string);
        expect(seenRequests[0].url).toBe('https://dev.azure.com/o365exchange/O365 Core/_apis/wit/wiql?$top=50&api-version=7.0');
    });
});
