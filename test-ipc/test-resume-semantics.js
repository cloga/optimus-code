const { spawn } = require('child_process');

function runCli(cmd, args, timeoutMs = 120000) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const child = spawn(cmd, args, {
            cwd: process.cwd(),
            env: { ...process.env, TERM: 'dumb', CI: 'false', FORCE_COLOR: '0' },
            shell: process.platform === 'win32'
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut });
        });

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
        });
    });
}

function extractSessionId(text) {
    const match = text.match(/session[_\s]?id[:\s]+([0-9a-f-]{36})/i)
        || text.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/i)
        || text.match(/"sessionId"\s*:\s*"([0-9a-f-]{36})"/i)
        || text.match(/sessionId[:\s]+"?([0-9a-f-]{36})"?/i);
    return match ? match[1] : null;
}

function parseClaudeText(raw) {
    let streamedText = '';
    let finalText = '';
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        try {
            const event = JSON.parse(line);
            if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                for (const block of event.message.content) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        streamedText += block.text;
                    }
                }
            }
            if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
                streamedText += event.delta.text;
            }
            if (event.type === 'result' && typeof event.result === 'string') {
                finalText = event.result;
            }
        } catch {
            // ignore non-json lines
        }
    }
    return (finalText || streamedText || raw).trim();
}

function parseCopilotText(raw) {
    let streamedText = '';
    let finalText = '';
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        try {
            const event = JSON.parse(line);
            if (event.type === 'assistant.message_delta' && typeof event.data?.deltaContent === 'string') {
                streamedText += event.data.deltaContent;
            }
            if (event.type === 'assistant.message' && typeof event.data?.content === 'string') {
                finalText = event.data.content;
            }
            if (event.type === 'result' && typeof event.result === 'string') {
                finalText = event.result;
            }
            if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
                streamedText += event.delta.text;
            }
        } catch {
            // ignore non-json lines
        }
    }
    return (finalText || streamedText || raw).trim();
}

async function testClaudeResume() {
    const secret = `CLAUDE-${Date.now().toString(36)}`;
    const first = await runCli('claude', [
        '-p',
        `Please remember this exact secret code for the next turn: ${secret}. Reply with exactly: ACK ${secret}`,
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ]);

    const firstCombined = `${first.stdout}\n${first.stderr}`;
    const sessionId = extractSessionId(firstCombined);
    const firstText = parseClaudeText(first.stdout);

    if (!sessionId) {
        return {
            engine: 'claude',
            ok: false,
            stage: 'turn1',
            reason: 'No session id found in turn 1 output',
            firstText,
            firstCombined: firstCombined.slice(0, 2000)
        };
    }

    const second = await runCli('claude', [
        '-p',
        'What exact secret code did I ask you to remember in the previous turn? Reply with only the secret code.',
        '--resume', sessionId,
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ]);

    const secondText = parseClaudeText(second.stdout);

    return {
        engine: 'claude',
        ok: secondText.includes(secret),
        stage: 'turn2',
        secret,
        sessionId,
        firstText,
        secondText,
        secondStderr: second.stderr.slice(0, 1000),
        timedOut: first.timedOut || second.timedOut
    };
}

async function testCopilotResume() {
    const secret = `COPILOT-${Date.now().toString(36)}`;
    const first = await runCli('copilot', [
        '-p',
        `Please remember this exact secret code for the next turn: ${secret}. Reply with exactly: ACK ${secret}`,
        '--allow-all-tools',
        '--no-ask-user',
        '--output-format', 'json',
        '--stream', 'on'
    ], 90000);

    const firstCombined = `${first.stdout}\n${first.stderr}`;
    if (/Would you like to reinstall GitHub Copilot CLI/i.test(firstCombined)) {
        return {
            engine: 'copilot',
            ok: false,
            stage: 'turn1',
            reason: 'Local Copilot CLI is not operational; it is prompting to reinstall instead of executing the prompt.',
            firstCombined: firstCombined.slice(0, 2000)
        };
    }

    const sessionId = extractSessionId(firstCombined);
    const firstText = parseCopilotText(first.stdout);

    if (!sessionId) {
        return {
            engine: 'copilot',
            ok: false,
            stage: 'turn1',
            reason: 'No session id found in turn 1 output',
            firstText,
            firstCombined: firstCombined.slice(0, 2000)
        };
    }

    const second = await runCli('copilot', [
        '-p',
        'What exact secret code did I ask you to remember in the previous turn? Reply with only the secret code.',
        '--resume', sessionId,
        '--allow-all-tools',
        '--no-ask-user',
        '--output-format', 'json',
        '--stream', 'on'
    ], 90000);

    const secondText = parseCopilotText(second.stdout);

    return {
        engine: 'copilot',
        ok: secondText.includes(secret),
        stage: 'turn2',
        secret,
        sessionId,
        firstText,
        secondText,
        secondStderr: second.stderr.slice(0, 1000),
        timedOut: first.timedOut || second.timedOut
    };
}

(async function main() {
    const results = [];
    results.push(await testClaudeResume());
    results.push(await testCopilotResume());
    console.log(JSON.stringify(results, null, 2));
})();
