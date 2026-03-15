#!/usr/bin/env node
/**
 * Mock ACP Server — Standalone JSON-RPC over stdio with dual-mode framing.
 *
 * Supports two framing modes:
 *   1. Content-Length (default) — LSP-style "Content-Length: <n>\r\n\r\n" + JSON body
 *   2. NDJSON — newline-delimited JSON (one JSON object per line)
 *
 * Framing mode is selected by:
 *   - `--ndjson` CLI flag forces NDJSON mode for both input and output
 *   - Auto-detection: if the first incoming data does NOT start with "Content-Length:",
 *     the server switches to NDJSON parsing for input (output remains Content-Length
 *     unless `--ndjson` was passed)
 *
 * Supported methods:
 *   - initialize          → success ack
 *   - session/new         → { sessionId: 'test-session-001' }
 *   - session/load        → echoes back the requested session
 *   - session/prompt      → 3 session/update notifications + final result
 *   - session/cancel      → acknowledgment
 *
 * Usage: node test-ipc/mock-acp-server.js [--ndjson]
 *        (reads from stdin, writes to stdout)
 *
 * Env flags:
 *   MOCK_ACP_CRASH_ON_PROMPT=1  — crash mid-response (for error tests)
 */

const CRASH_ON_PROMPT = process.env.MOCK_ACP_CRASH_ON_PROMPT === '1';
const FORCE_NDJSON = process.argv.includes('--ndjson');

let useNdjsonOutput = FORCE_NDJSON;
let useNdjsonInput = FORCE_NDJSON;
let framingDetected = FORCE_NDJSON; // skip auto-detection if flag is set

// ─── Output Helpers ──────────────────────────────────────────────────────────

function sendMessage(obj) {
    if (useNdjsonOutput) {
        process.stdout.write(JSON.stringify(obj) + '\n');
    } else {
        const body = JSON.stringify(obj);
        const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
        process.stdout.write(header + body);
    }
}

// ─── Incoming message parser (Content-Length framed) ─────────────────────────

let buffer = Buffer.alloc(0);

function parseContentLengthMessages() {
    const messages = [];
    while (true) {
        // Look for the header separator
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const headerStr = buffer.slice(0, headerEnd).toString('utf8');
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
            // Malformed header — skip past it
            buffer = buffer.slice(headerEnd + 4);
            continue;
        }

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + contentLength;

        if (buffer.length < bodyEnd) {
            // Not enough data yet — wait for more
            break;
        }

        const bodyStr = buffer.slice(bodyStart, bodyEnd).toString('utf8');
        buffer = buffer.slice(bodyEnd);

        try {
            messages.push(JSON.parse(bodyStr));
        } catch (err) {
            // Skip unparseable bodies
        }
    }
    return messages;
}

function parseNdjsonMessages() {
    const messages = [];
    const str = buffer.toString('utf8');
    const lines = str.split('\n');

    // Keep the last incomplete line in buffer
    const incomplete = lines[lines.length - 1];
    const complete = lines.slice(0, -1);

    for (const line of complete) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            messages.push(JSON.parse(trimmed));
        } catch (err) {
            // Skip unparseable lines
        }
    }

    buffer = Buffer.from(incomplete, 'utf8');
    return messages;
}

function parseMessages() {
    if (useNdjsonInput) {
        return parseNdjsonMessages();
    } else {
        return parseContentLengthMessages();
    }
}

// ─── Method Handlers ─────────────────────────────────────────────────────────

function handleInitialize(msg) {
    sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
            protocolVersion: '1.0',
            serverInfo: { name: 'mock-acp-server', version: '0.1.0' },
            capabilities: {}
        }
    });
}

function handleSessionNew(msg) {
    sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionId: 'test-session-001' }
    });
}

function handleSessionLoad(msg) {
    const requestedId = (msg.params && msg.params.sessionId) || 'unknown-session';
    sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionId: requestedId, restored: true }
    });
}

function handleSessionPrompt(msg) {
    if (CRASH_ON_PROMPT) {
        // Send one notification then hard-crash
        sendMessage({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'chunk-before-crash' }
                }
            }
        });
        // Force exit to simulate crash
        process.exit(1);
    }

    const chunks = ['Hello, ', 'this is ', 'a test response.'];

    // Send 3 incremental notifications using sessionUpdate wrapper
    for (const chunk of chunks) {
        sendMessage({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: chunk }
                }
            }
        });
    }

    // Send final response
    sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
            text: chunks.join(''),
            stopReason: 'end_turn',
            sessionId: (msg.params && msg.params.sessionId) || 'test-session-001'
        }
    });
}

function handleSessionCancel(msg) {
    sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: { cancelled: true }
    });
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

function dispatch(msg) {
    switch (msg.method) {
        case 'initialize':
            handleInitialize(msg);
            break;
        case 'session/new':
            handleSessionNew(msg);
            break;
        case 'session/load':
            handleSessionLoad(msg);
            break;
        case 'session/prompt':
            handleSessionPrompt(msg);
            break;
        case 'session/cancel':
            handleSessionCancel(msg);
            break;
        default:
            // Unknown method — return error
            sendMessage({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32601, message: `Method not found: ${msg.method}` }
            });
    }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

process.stdin.on('data', (chunk) => {
    // Auto-detect framing from first incoming data chunk
    if (!framingDetected) {
        framingDetected = true;
        const preview = chunk.toString('utf8').trimStart();
        if (!preview.startsWith('Content-Length:')) {
            useNdjsonInput = true;
            // If input is NDJSON, also switch output to NDJSON
            useNdjsonOutput = true;
        }
    }

    buffer = Buffer.concat([buffer, chunk]);
    const messages = parseMessages();
    for (const msg of messages) {
        dispatch(msg);
    }
});

process.stdin.on('end', () => {
    // Client disconnected — exit cleanly
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    process.stderr.write(`[mock-acp-server] uncaught: ${err.message}\n`);
    process.exit(1);
});
