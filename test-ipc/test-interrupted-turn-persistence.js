const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const windowsSpawnResolutionCache = new Map();

function resolveWindowsSpawnResolution(cmd) {
  const cached = windowsSpawnResolutionCache.get(cmd);
  if (cached !== undefined) return cached;

  const whereResult = spawnSync('where.exe', [cmd], { encoding: 'utf8' });
  if (whereResult.status !== 0 || !whereResult.stdout) {
    windowsSpawnResolutionCache.set(cmd, null);
    return null;
  }

  const candidates = whereResult.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(candidate => fs.existsSync(candidate));

  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (ext === '.exe' || ext === '.com') {
      const resolved = { cmd: candidate, argsPrefix: [] };
      windowsSpawnResolutionCache.set(cmd, resolved);
      return resolved;
    }

    if (ext === '.cmd') {
      try {
        const wrapperText = fs.readFileSync(candidate, 'utf8');
        const scriptMatch = wrapperText.match(/"%dp0%\\([^\"]+?\.js)"/i);
        if (scriptMatch) {
          const wrapperDir = path.dirname(candidate);
          const nodeExecutable = fs.existsSync(path.join(wrapperDir, 'node.exe')) ? path.join(wrapperDir, 'node.exe') : 'node';
          const entryScript = path.join(wrapperDir, scriptMatch[1].replace(/\\/g, path.sep));
          const resolved = { cmd: nodeExecutable, argsPrefix: [entryScript] };
          windowsSpawnResolutionCache.set(cmd, resolved);
          return resolved;
        }
      } catch {}
    }
  }

  windowsSpawnResolutionCache.set(cmd, null);
  return null;
}

function platformSpawn(cmd, args, options = {}) {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsSpawnResolution(cmd);
    if (resolved) return spawn(resolved.cmd, [...resolved.argsPrefix, ...args], options);
  }
  return spawn(cmd, args, options);
}

function platformSpawnSync(cmd, args, options = {}) {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsSpawnResolution(cmd);
    if (resolved) return spawnSync(resolved.cmd, [...resolved.argsPrefix, ...args], options);
  }
  return spawnSync(cmd, args, options);
}

function runSync(cmd, args, timeout = 120000) {
  const r = platformSpawnSync(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'dumb', CI: 'false', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout,
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

function startAndKill(cmd, args, killAfterMs = 1500) {
  return new Promise((resolve) => {
    const child = platformSpawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'dumb', CI: 'false', FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, killAfterMs);

    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });

    child.on('error', (error) => {
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}\n${String(error.message || error)}` });
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
      if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') streamed += event.delta.text;
      if (event.type === 'result' && typeof event.result === 'string') finalText = event.result;
    } catch {}
  }
  return (finalText || streamed || raw).trim();
}

function parseCopilotText(raw) {
  let streamed = '';
  let finalText = '';
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant.message_delta' && typeof event.data?.deltaContent === 'string') streamed += event.data.deltaContent;
      if (event.type === 'assistant.message' && typeof event.data?.content === 'string') finalText = event.data.content;
      if (event.type === 'result' && typeof event.result === 'string') finalText = event.result;
      if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') streamed += event.delta.text;
    } catch {}
  }
  return (finalText || streamed || raw).trim();
}

async function testClaude() {
  const setup = runSync('claude', ['-p', 'Reply exactly READY.', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']);
  const sessionId = extractSessionId(`${setup.stdout}\n${setup.stderr}`);
  if (!sessionId) {
    return { engine: 'claude', ok: false, stage: 'setup', stderr: setup.stderr.slice(0, 800), stdout: setup.stdout.slice(0, 800) };
  }

  const token = `CLAUDE-INT-${Date.now()}`;
  const interrupted = await startAndKill('claude', [
    '-p',
    `Use a shell command to sleep for 15 seconds, then reply with exactly ${token}.`,
    '--resume', sessionId,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose'
  ], 1500);

  const resumed = runSync('claude', [
    '-p',
    'In the immediately previous user request before this message, what exact token was I expecting you to reply with after sleeping? Reply with only the token or UNKNOWN.',
    '--resume', sessionId,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose'
  ]);

  const resumedText = parseClaudeText(resumed.stdout);
  return {
    engine: 'claude',
    sessionId,
    token,
    interruptedStatus: interrupted.status,
    interruptedSignal: interrupted.signal,
    resumedText,
    rememberedInterruptedTurn: resumedText.includes(token),
  };
}

async function testCopilot() {
  const setup = runSync('copilot', ['-p', 'Reply exactly READY.', '--allow-all-tools', '--no-ask-user', '--output-format', 'json', '--stream', 'on'], 90000);
  const combined = `${setup.stdout}\n${setup.stderr}`;
  if (/Would you like to reinstall GitHub Copilot CLI/i.test(combined)) {
    return { engine: 'copilot', ok: false, stage: 'setup', reason: 'copilot reinstall prompt' };
  }
  const sessionId = extractSessionId(combined);
  if (!sessionId) {
    return { engine: 'copilot', ok: false, stage: 'setup', stderr: setup.stderr.slice(0, 800), stdout: setup.stdout.slice(0, 800) };
  }

  const token = `COPILOT-INT-${Date.now()}`;
  const interrupted = await startAndKill('copilot', [
    '-p',
    `Use a shell command to sleep for 15 seconds, then reply with exactly ${token}.`,
    '--resume', sessionId,
    '--allow-all-tools',
    '--no-ask-user',
    '--output-format', 'json',
    '--stream', 'on'
  ], 1500);

  const resumed = runSync('copilot', [
    '-p',
    'In the immediately previous user request before this message, what exact token was I expecting you to reply with after sleeping? Reply with only the token or UNKNOWN.',
    '--resume', sessionId,
    '--allow-all-tools',
    '--no-ask-user',
    '--output-format', 'json',
    '--stream', 'on'
  ], 90000);

  const resumedText = parseCopilotText(resumed.stdout);
  return {
    engine: 'copilot',
    sessionId,
    token,
    interruptedStatus: interrupted.status,
    interruptedSignal: interrupted.signal,
    resumedText,
    rememberedInterruptedTurn: resumedText.includes(token),
  };
}

(async () => {
  const results = [];
  results.push(await testClaude());
  results.push(await testCopilot());
  console.log(JSON.stringify(results, null, 2));
})();
