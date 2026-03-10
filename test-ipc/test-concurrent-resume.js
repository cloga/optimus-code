const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const windowsSpawnResolutionCache = new Map();

function resolveWindowsSpawnResolution(cmd) {
  const cached = windowsSpawnResolutionCache.get(cmd);
  if (cached !== undefined) {
    return cached;
  }

  const whereResult = spawnSync('where.exe', [cmd], { encoding: 'utf8' });
  if (whereResult.status !== 0 || !whereResult.stdout) {
    windowsSpawnResolutionCache.set(cmd, null);
    return null;
  }

  const candidates = whereResult.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(candidate => fs.existsSync(candidate))
    .sort((left, right) => {
      const extRank = (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.exe' || ext === '.com') return 0;
        if (ext === '.cmd') return 1;
        if (ext === '.bat') return 2;
        return 3;
      };
      return extRank(left) - extRank(right);
    });

  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (ext === '.exe' || ext === '.com') {
      const resolved = { cmd: candidate, argsPrefix: [] };
      windowsSpawnResolutionCache.set(cmd, resolved);
      return resolved;
    }

    if (ext !== '.cmd') {
      continue;
    }

    try {
      const wrapperText = fs.readFileSync(candidate, 'utf8');
      const scriptMatch = wrapperText.match(/"%dp0%\\([^\"]+?\.js)"/i);
      if (!scriptMatch) {
        continue;
      }

      const wrapperDir = path.dirname(candidate);
      const nodeExecutable = fs.existsSync(path.join(wrapperDir, 'node.exe'))
        ? path.join(wrapperDir, 'node.exe')
        : 'node';
      const entryScript = path.join(wrapperDir, scriptMatch[1].replace(/\\/g, path.sep));
      const resolved = { cmd: nodeExecutable, argsPrefix: [entryScript] };
      windowsSpawnResolutionCache.set(cmd, resolved);
      return resolved;
    } catch {
      continue;
    }
  }

  windowsSpawnResolutionCache.set(cmd, null);
  return null;
}

function platformSpawn(cmd, args, options = {}) {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsSpawnResolution(cmd);
    if (resolved) {
      return spawn(resolved.cmd, [...resolved.argsPrefix, ...args], options);
    }
    return spawn('cmd.exe', ['/d', '/s', '/c', cmd, ...args], options);
  }
  return spawn(cmd, args, options);
}

function platformSpawnSync(cmd, args, options = {}) {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsSpawnResolution(cmd);
    if (resolved) {
      return spawnSync(resolved.cmd, [...resolved.argsPrefix, ...args], options);
    }
    return spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], options);
  }
  return spawnSync(cmd, args, options);
}

function runSync(cmd, args, timeout = 120000) {
  const result = platformSpawnSync(cmd, args, { encoding: 'utf8', timeout });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function spawnAsync(cmd, args, timeout = 120000) {
  const child = platformSpawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'dumb', CI: 'false', FORCE_COLOR: '0' }
  });

  let stdout = '';
  let stderr = '';
  const startedAt = Date.now();

  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ status: null, signal: 'SIGTERM', stdout, stderr, timedOut: true, durationMs: Date.now() - startedAt });
    }, timeout);

    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut: false, durationMs: Date.now() - startedAt });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}\n${String(error.message || error)}`, timedOut: false, durationMs: Date.now() - startedAt });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function prepareClaudeSession() {
  const token = `SETUP-CLAUDE-${Date.now()}`;
  const setup = runSync('claude', ['-p', `Remember ${token} and reply only with it.`, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']);
  const combined = `${setup.stdout}\n${setup.stderr}`;
  return { sessionId: extractSessionId(combined), setupText: parseClaudeText(setup.stdout), token, setup };
}

async function prepareCopilotSession() {
  const token = `SETUP-COPILOT-${Date.now()}`;
  const setup = runSync('copilot', ['-p', `Remember ${token} and reply only with it.`, '--allow-all-tools', '--no-ask-user', '--output-format', 'json', '--stream', 'on'], 90000);
  const combined = `${setup.stdout}\n${setup.stderr}`;
  return { sessionId: extractSessionId(combined), setupText: parseCopilotText(setup.stdout), token, setup, combined };
}

async function testClaudeConcurrent() {
  const prepared = await prepareClaudeSession();
  if (!prepared.sessionId) {
    return { engine: 'claude', ok: false, reason: 'setup failed to yield session id', setupText: prepared.setupText, stderr: prepared.setup.stderr.slice(0, 1200) };
  }

  const longPrompt = [
    'Before answering, use a shell command to wait about 15 seconds.',
    'On Windows you may use PowerShell Start-Sleep -Seconds 15.',
    'After the wait, reply with exactly FIRST_DONE.'
  ].join(' ');

  const firstPromise = spawnAsync('claude', ['-p', longPrompt, '--resume', prepared.sessionId, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], 120000);
  await sleep(2500);
  const second = await spawnAsync('claude', ['-p', 'Reply with exactly SECOND_DONE.', '--resume', prepared.sessionId, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], 60000);
  const first = await firstPromise;

  return {
    engine: 'claude',
    sessionId: prepared.sessionId,
    firstText: parseClaudeText(first.stdout),
    secondText: parseClaudeText(second.stdout),
    firstDurationMs: first.durationMs,
    secondDurationMs: second.durationMs,
    secondStderr: second.stderr.slice(0, 1000),
    overlapObserved: second.durationMs < first.durationMs,
    secondStatus: second.status,
    firstStatus: first.status
  };
}

async function testCopilotConcurrent() {
  const prepared = await prepareCopilotSession();
  if (/Would you like to reinstall GitHub Copilot CLI/i.test(prepared.combined || '')) {
    return { engine: 'copilot', ok: false, reason: 'copilot cli blocked by reinstall prompt' };
  }
  if (!prepared.sessionId) {
    return { engine: 'copilot', ok: false, reason: 'setup failed to yield session id', setupText: prepared.setupText, stderr: prepared.setup.stderr.slice(0, 1200) };
  }

  const longPrompt = [
    'Before answering, use a shell command to wait about 15 seconds.',
    'On Windows you may use PowerShell Start-Sleep -Seconds 15.',
    'After the wait, reply with exactly FIRST_DONE.'
  ].join(' ');

  const firstPromise = spawnAsync('copilot', ['-p', longPrompt, '--resume', prepared.sessionId, '--allow-all-tools', '--no-ask-user', '--output-format', 'json', '--stream', 'on'], 120000);
  await sleep(2500);
  const second = await spawnAsync('copilot', ['-p', 'Reply with exactly SECOND_DONE.', '--resume', prepared.sessionId, '--allow-all-tools', '--no-ask-user', '--output-format', 'json', '--stream', 'on'], 60000);
  const first = await firstPromise;

  return {
    engine: 'copilot',
    sessionId: prepared.sessionId,
    firstText: parseCopilotText(first.stdout),
    secondText: parseCopilotText(second.stdout),
    firstDurationMs: first.durationMs,
    secondDurationMs: second.durationMs,
    secondStderr: second.stderr.slice(0, 1000),
    overlapObserved: second.durationMs < first.durationMs,
    secondStatus: second.status,
    firstStatus: first.status
  };
}

(async () => {
  const results = [];
  results.push(await testClaudeConcurrent());
  results.push(await testCopilotConcurrent());
  console.log(JSON.stringify(results, null, 2));
})();
