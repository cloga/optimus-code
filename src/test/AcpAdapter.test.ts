/**
 * AcpAdapter Integration Test
 *
 * Tests:
 *   1. Handshake test — mock server responds to initialize
 *   2. New session test — session/new returns a sessionId
 *   3. Streaming test — session/prompt sends incremental chunks then final response
 *   4. Session resume test — session/load returns the requested sessionId
 *   5. Stop / cancel test — session/cancel returns acknowledgment
 *   6. Error test — mock server crash mid-response rejects the client promise
 *   7. AcpAdapter unit tests — validate adapter interface conformance
 *   8. AcpAdapter.invoke() — end-to-end via NDJSON mock server
 *   9. AcpAdapter.stop() — safety when no process running
 *  10. AcpAdapter.extractThinking() — returns empty thinking for ACP
 *  11. Content-Length framing edge cases
 *  12. Unknown method error handling
 *  13. AcpAdapter session resume — session/load via NDJSON mock server
 *
 * Run: npx tsx src/test/AcpAdapter.test.ts
 */
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { AcpAdapter } from '../adapters/AcpAdapter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_SERVER = path.resolve(__dirname, '..', '..', 'test-ipc', 'mock-acp-server.js');

/** Encode a JSON-RPC message with Content-Length framing */
function encode(obj: Record<string, unknown>): Buffer {
    const body = JSON.stringify(obj);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    return Buffer.from(header + body, 'utf8');
}

/** Decode Content-Length framed messages from a Buffer */
function decodeAll(buf: Buffer): Record<string, any>[] {
    const results: Record<string, any>[] = [];
    let remaining = buf;
    while (remaining.length > 0) {
        const headerEnd = remaining.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const headerStr = remaining.slice(0, headerEnd).toString('utf8');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;
        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;
        if (remaining.length < bodyEnd) break;
        const bodyStr = remaining.slice(bodyStart, bodyEnd).toString('utf8');
        remaining = remaining.slice(bodyEnd);
        try {
            results.push(JSON.parse(bodyStr));
        } catch { break; }
    }
    return results;
}

/** Spawn mock server, collect all stdout messages, and resolve when it exits or after timeout */
function spawnMock(env?: Record<string, string>): {
    proc: ChildProcess;
    send: (obj: Record<string, unknown>) => void;
    collectUntilExit: (timeoutMs?: number) => Promise<Record<string, any>[]>;
} {
    const proc = spawn(process.execPath, [MOCK_SERVER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env }
    });

    let stdoutBuf = Buffer.alloc(0);
    proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    });

    const send = (obj: Record<string, unknown>) => {
        proc.stdin!.write(encode(obj));
    };

    const collectUntilExit = (timeoutMs = 5000): Promise<Record<string, any>[]> => {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                proc.kill('SIGTERM');
                resolve(decodeAll(stdoutBuf));
            }, timeoutMs);

            proc.on('close', () => {
                clearTimeout(timer);
                // Small delay to ensure all stdout data is flushed
                setTimeout(() => resolve(decodeAll(stdoutBuf)), 100);
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    };

    return { proc, send, collectUntilExit };
}

/** Simple helper — send a sequence of messages, close stdin, collect responses */
async function roundTrip(
    messages: Record<string, unknown>[],
    env?: Record<string, string>,
    delayBetweenMs = 50
): Promise<Record<string, any>[]> {
    const { proc, send, collectUntilExit } = spawnMock(env);

    const done = collectUntilExit(8000);

    for (let i = 0; i < messages.length; i++) {
        send(messages[i]);
        if (i < messages.length - 1 && delayBetweenMs > 0) {
            await new Promise(r => setTimeout(r, delayBetweenMs));
        }
    }

    // Give server time to process, then close stdin
    await new Promise(r => setTimeout(r, 200));
    proc.stdin!.end();

    return done;
}

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label: string, condition: boolean) {
    if (condition) {
        console.log(`  PASS: ${label}`);
        passed++;
    } else {
        console.log(`  FAIL: ${label}`);
        failed++;
    }
}

async function run() {
    console.log('\n=== AcpAdapter Integration Tests ===\n');

    // ─── TEST 1: Handshake — initialize ──────────────────────────────────
    console.log('--- Test 1: Handshake (initialize) ---');
    {
        const responses = await roundTrip([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
        ]);
        test('Got at least 1 response', responses.length >= 1);
        const initResp = responses.find(r => r.id === 1);
        test('Initialize response has id=1', !!initResp);
        test('Result has protocolVersion', initResp?.result?.protocolVersion === '1.0');
        test('Result has serverInfo name', initResp?.result?.serverInfo?.name === 'mock-acp-server');
    }

    // ─── TEST 2: New Session ─────────────────────────────────────────────
    console.log('\n--- Test 2: New Session (session/new) ---');
    {
        const responses = await roundTrip([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }
        ]);
        const sessionResp = responses.find(r => r.id === 2);
        test('session/new response received', !!sessionResp);
        test('sessionId is test-session-001', sessionResp?.result?.sessionId === 'test-session-001');
    }

    // ─── TEST 3: Streaming — session/prompt with updates ─────────────────
    console.log('\n--- Test 3: Streaming (session/prompt with updates) ---');
    {
        const responses = await roundTrip([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
            { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { text: 'test prompt', sessionId: 'test-session-001' } }
        ]);

        // Should have: initialize result, session/new result, 3 updates, final prompt result
        const updates = responses.filter(r => r.method === 'session/update');
        test('Received 3 session/update notifications', updates.length === 3);
        test('First chunk is "Hello, "', updates[0]?.params?.update?.content?.text === 'Hello, ');
        test('Second chunk is "this is "', updates[1]?.params?.update?.content?.text === 'this is ');
        test('Third chunk is "a test response."', updates[2]?.params?.update?.content?.text === 'a test response.');

        const promptResp = responses.find(r => r.id === 3);
        test('Final prompt response received', !!promptResp);
        test('Final text is concatenation of chunks', promptResp?.result?.text === 'Hello, this is a test response.');
    }

    // ─── TEST 4: Session Resume — session/load ───────────────────────────
    console.log('\n--- Test 4: Session Resume (session/load) ---');
    {
        const responses = await roundTrip([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'my-existing-session-42' } }
        ]);
        const loadResp = responses.find(r => r.id === 2);
        test('session/load response received', !!loadResp);
        test('Returns requested sessionId', loadResp?.result?.sessionId === 'my-existing-session-42');
        test('Marks restored=true', loadResp?.result?.restored === true);
    }

    // ─── TEST 5: Stop — session/cancel ───────────────────────────────────
    console.log('\n--- Test 5: Stop (session/cancel) ---');
    {
        const responses = await roundTrip([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'session/cancel', params: { sessionId: 'test-session-001' } }
        ]);
        const cancelResp = responses.find(r => r.id === 2);
        test('session/cancel response received', !!cancelResp);
        test('cancelled=true', cancelResp?.result?.cancelled === true);
    }

    // ─── TEST 6: Error — mock server crashes mid-response ────────────────
    console.log('\n--- Test 6: Error (server crash mid-response) ---');
    {
        const responses = await roundTrip(
            [
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
                { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
                { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { text: 'crash me', sessionId: 'test-session-001' } }
            ],
            { MOCK_ACP_CRASH_ON_PROMPT: '1' }
        );

        // The server should crash after sending at most 1 update — no final result for id=3
        const promptResp = responses.find(r => r.id === 3 && r.result);
        test('No final prompt response (server crashed)', !promptResp);

        // Should have received at most 1 partial update before crash
        const updates = responses.filter(r => r.method === 'session/update');
        test('Received at most 1 partial update before crash', updates.length <= 1);
    }

    // ─── TEST 7: AcpAdapter Unit — interface conformance ─────────────────
    console.log('\n--- Test 7: AcpAdapter Unit (interface & stub behavior) ---');
    {
        const adapter = new AcpAdapter('test-acp', 'Test ACP Agent', 'node', ['--version']);
        test('id is set', adapter.id === 'test-acp');
        test('name is set', adapter.name === 'Test ACP Agent');
        test('isEnabled defaults to true', adapter.isEnabled === true);
        test('modes includes plan', adapter.modes.includes('plan'));
        test('modes includes agent', adapter.modes.includes('agent'));
        test('lastSessionId is initially undefined', adapter.lastSessionId === undefined);
    }

    // ─── TEST 8: AcpAdapter.invoke() via NDJSON mock server ────────────────
    console.log('\n--- Test 8: AcpAdapter.invoke() via NDJSON mock ---');
    {
        const adapter = new AcpAdapter('invoke-test', 'Invoke Test', 'node', [MOCK_SERVER, '--ndjson']);
        const chunks: string[] = [];
        const result = await adapter.invoke('hello', 'agent', undefined, (chunk) => {
            chunks.push(chunk);
        });

        test('invoke resolves with a string', typeof result === 'string');
        test('Result contains expected mock response text', result.includes('Hello, this is a test response.'));
        test('onUpdate was called with chunk text', chunks.length >= 1);
        test('lastSessionId set after invoke', adapter.lastSessionId !== undefined);
        test('lastSessionId is test-session-001', adapter.lastSessionId === 'test-session-001');
    }

    // ─── TEST 9: AcpAdapter.stop() does not throw ────────────────────────
    console.log('\n--- Test 9: AcpAdapter.stop() safety ---');
    {
        const adapter = new AcpAdapter('stop-test', 'Stop Test', 'node');
        // stop() with no process should not throw
        let threw = false;
        try {
            adapter.stop();
        } catch {
            threw = true;
        }
        test('stop() with no process does not throw', !threw);
    }

    // ─── TEST 10: AcpAdapter.extractThinking() ───────────────────────────
    console.log('\n--- Test 10: AcpAdapter.extractThinking() ---');
    {
        const adapter = new AcpAdapter('think-test', 'Think Test', 'node');
        const result = adapter.extractThinking('Some raw output text');
        test('output matches input', result.output === 'Some raw output text');
        test('thinking is empty string (ACP uses separate notifications)', result.thinking === '');
    }

    // ─── TEST 11: Content-Length framing edge cases ──────────────────────
    console.log('\n--- Test 11: Protocol framing edge cases ---');
    {
        // Test encode/decode roundtrip
        const original = { jsonrpc: '2.0', id: 99, method: 'test', params: { emoji: '\u2603', unicode: '\u00e9' } };
        const encoded = encode(original);
        const decoded = decodeAll(encoded);
        test('Encode/decode roundtrip preserves data', decoded.length === 1 && decoded[0].id === 99);
        test('Unicode preserved', decoded[0]?.params?.emoji === '\u2603');

        // Test multiple messages in a single buffer
        const multi = Buffer.concat([
            encode({ jsonrpc: '2.0', id: 1, result: 'a' }),
            encode({ jsonrpc: '2.0', id: 2, result: 'b' }),
            encode({ jsonrpc: '2.0', id: 3, result: 'c' })
        ]);
        const multiDecoded = decodeAll(multi);
        test('Multiple messages decoded from single buffer', multiDecoded.length === 3);
        test('Correct ordering of multi-decode', multiDecoded[0]?.id === 1 && multiDecoded[2]?.id === 3);
    }

    // ─── TEST 12: Unknown method returns error ───────────────────────────
    console.log('\n--- Test 12: Unknown method error ---');
    {
        const responses = await roundTrip([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            { jsonrpc: '2.0', id: 99, method: 'nonexistent/method', params: {} }
        ]);
        const errResp = responses.find(r => r.id === 99);
        test('Error response received for unknown method', !!errResp?.error);
        test('Error code is -32601 (Method not found)', errResp?.error?.code === -32601);
    }

    // ─── TEST 13: AcpAdapter session resume via NDJSON mock ────────────
    console.log('\n--- Test 13: AcpAdapter session resume ---');
    {
        const adapter = new AcpAdapter('resume-test', 'Resume Test', 'node', [MOCK_SERVER, '--ndjson']);
        const result = await adapter.invoke('hello again', 'agent', 'my-previous-session');

        test('invoke with sessionId resolves with a string', typeof result === 'string');
        test('lastSessionId is the resumed session ID', adapter.lastSessionId === 'my-previous-session');
    }

    // ─── Summary ─────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
    console.log(`${'='.repeat(50)}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
