const { spawnSync } = require('child_process');

function runCli(cmd, args, timeout = 90000) {
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

function extractCopilotText(raw) {
  let streamed = '';
  let finalText = '';
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant.message_delta' && typeof event.data?.deltaContent === 'string') {
        streamed += event.data.deltaContent;
      }
      if (event.type === 'assistant.message' && typeof event.data?.content === 'string') {
        finalText = event.data.content;
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

const token = `COPILOT-RESUME-${Date.now()}`;
console.log('[copilot] token =', token);

const turn1 = runCli('copilot', [
  '-p',
  `Please remember this secret token exactly: ${token}. Reply with ONLY the token.`,
  '--allow-all-tools',
  '--no-ask-user',
  '--output-format', 'json',
  '--stream', 'on'
]);

const combined1 = `${turn1.stdout}\n${turn1.stderr}`;
const sessionId = extractSessionId(combined1);
const text1 = extractCopilotText(turn1.stdout);

console.log('\n[copilot] turn1 status =', turn1.status, 'signal =', turn1.signal, 'error =', turn1.error && turn1.error.message);
console.log('[copilot] turn1 sessionId =', sessionId);
console.log('[copilot] turn1 text =', text1.slice(0, 500));
if (/Would you like to reinstall GitHub Copilot CLI\?/i.test(combined1)) {
  console.error('\n[copilot] ENVIRONMENT BLOCKED: Copilot CLI is prompting for reinstall, so resume behavior cannot be validated until the CLI is fixed.');
  process.exit(3);
}

if (!sessionId) {
  console.error('\n[copilot] FAIL: no session id detected.');
  process.exit(2);
}

const turn2 = runCli('copilot', [
  '-p',
  'What secret token did I ask you to remember earlier? Reply with ONLY the token.',
  '--resume', sessionId,
  '--allow-all-tools',
  '--no-ask-user',
  '--output-format', 'json',
  '--stream', 'on'
]);

const text2 = extractCopilotText(turn2.stdout);
console.log('\n[copilot] turn2 status =', turn2.status, 'signal =', turn2.signal, 'error =', turn2.error && turn2.error.message);
console.log('[copilot] turn2 text =', text2.slice(0, 500));

const ok = text2.includes(token);
console.log(`\n[copilot] explicit resume memory test = ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
