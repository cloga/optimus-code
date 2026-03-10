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
  const candidates = whereResult.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(fs.existsSync);
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
  const r = platformSpawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error && String(r.error.message || r.error) };
}

function spawnAsync(cmd, args, timeout = 120000) {
  const child = platformSpawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, TERM: 'dumb', CI: 'false', FORCE_COLOR: '0' } });
  let stdout = '';
  let stderr = '';
  const startedAt = Date.now();
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ status: null, stdout, stderr, durationMs: Date.now() - startedAt, timedOut: true });
    }, timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, durationMs: Date.now() - startedAt, timedOut: false });
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
      if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') streamed += event.delta.text;
      if (event.type === 'result' && typeof event.result === 'string') finalText = event.result;
    } catch {}
  }
  return (finalText || streamed || raw).trim();
}

(async () => {
  const setup = runSync('claude', ['-p', 'Reply exactly READY.', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']);
  const sessionId = extractSessionId(`${setup.stdout}\n${setup.stderr}`);
  if (!sessionId) {
    console.error(JSON.stringify({ ok: false, stage: 'setup', stderr: setup.stderr.slice(0, 1000), stdout: setup.stdout.slice(0, 1000) }, null, 2));
    process.exit(2);
  }

  const firstPromise = spawnAsync('claude', ['-p', 'Write the word LINE on 4000 separate lines, then on the final line write FIRST_DONE.', '--resume', sessionId, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], 180000);
  await new Promise(r => setTimeout(r, 1000));
  const second = await spawnAsync('claude', ['-p', 'Reply with exactly SECOND_DONE.', '--resume', sessionId, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], 60000);
  const first = await firstPromise;

  console.log(JSON.stringify({
    sessionId,
    firstDurationMs: first.durationMs,
    secondDurationMs: second.durationMs,
    firstTimedOut: first.timedOut,
    secondTimedOut: second.timedOut,
    firstStatus: first.status,
    secondStatus: second.status,
    firstPreview: extractClaudeText(first.stdout).slice(0, 200),
    secondPreview: extractClaudeText(second.stdout).slice(0, 200),
    secondStderr: second.stderr.slice(0, 1000)
  }, null, 2));
})();
