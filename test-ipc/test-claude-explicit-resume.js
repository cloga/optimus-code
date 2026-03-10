const { spawnSync } = require('child_process');

function runCli(cmd, args, timeout = 120000) {
  const isWin = process.platform === 'win32';
  const result = isWin
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { encoding: 'utf8', timeout })
    : spawnSync(cmd, args, { encoding: 'utf8', timeout });

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function extractSessionId(text) {
  const match = text.match(/session[_\s]?id[:\s]+([0-9a-f-]{36})/i)
    || text.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/i)
    || text.match(/"sessionId"\s*:\s*"([0-9a-f-]{36})"/i)
    || text.match(/sessionId[:\s]+"?([0-9a-f-]{36})"?/i);
  return match ? match[1] : null;
}

function extractClaudeText(raw) {
  let streamed = '';
  let finalText = '';
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') streamed += block.text;
        }
      }
      if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
        streamed += event.delta.text;
      }
      if (event.type === 'result' && typeof event.result === 'string') {
        finalText = event.result;
      }
    } catch {
      // ignore non-json lines
    }
  }
  return (finalText || streamed || raw).trim();
}

const token = `CLAUDE-RESUME-${Date.now()}`;
console.log('[claude] token =', token);

const turn1 = runCli('claude', [
  '-p',
  `Please remember this secret token exactly: ${token}. Reply with ONLY the token.`,
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose'
]);

const combined1 = `${turn1.stdout}\n${turn1.stderr}`;
const sessionId = extractSessionId(combined1);
const text1 = extractClaudeText(turn1.stdout);

console.log('\n[claude] turn1 status =', turn1.status, 'signal =', turn1.signal, 'error =', turn1.error && turn1.error.message);
console.log('[claude] turn1 sessionId =', sessionId);
console.log('[claude] turn1 text =', text1);

if (!sessionId) {
  console.error('\n[claude] FAIL: no session id detected.');
  process.exit(2);
}

const turn2 = runCli('claude', [
  '-p',
  'What secret token did I ask you to remember earlier? Reply with ONLY the token.',
  '--resume', sessionId,
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose'
]);

const text2 = extractClaudeText(turn2.stdout);
console.log('\n[claude] turn2 status =', turn2.status, 'signal =', turn2.signal, 'error =', turn2.error && turn2.error.message);
console.log('[claude] turn2 text =', text2);

const ok = text2.includes(token);
console.log(`\n[claude] explicit resume memory test = ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
