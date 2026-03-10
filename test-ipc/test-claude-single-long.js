const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveWindowsSpawnResolution(cmd) {
  const whereResult = spawnSync('where.exe', [cmd], { encoding: 'utf8' });
  if (whereResult.status !== 0 || !whereResult.stdout) return null;
  const candidates = whereResult.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(fs.existsSync);
  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (ext === '.exe' || ext === '.com') return { cmd: candidate, argsPrefix: [] };
    if (ext === '.cmd') {
      try {
        const wrapperText = fs.readFileSync(candidate, 'utf8');
        const scriptMatch = wrapperText.match(/"%dp0%\\([^\"]+?\.js)"/i);
        if (scriptMatch) {
          const wrapperDir = path.dirname(candidate);
          const nodeExecutable = fs.existsSync(path.join(wrapperDir, 'node.exe')) ? path.join(wrapperDir, 'node.exe') : 'node';
          const entryScript = path.join(wrapperDir, scriptMatch[1].replace(/\\/g, path.sep));
          return { cmd: nodeExecutable, argsPrefix: [entryScript] };
        }
      } catch {}
    }
  }
  return null;
}

function platformSpawnSync(cmd, args, options = {}) {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsSpawnResolution(cmd);
    if (resolved) return spawnSync(resolved.cmd, [...resolved.argsPrefix, ...args], options);
  }
  return spawnSync(cmd, args, options);
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

const setup = platformSpawnSync('claude', ['-p', 'Reply exactly READY.', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], { encoding: 'utf8', timeout: 120000 });
const sessionId = extractSessionId(`${setup.stdout || ''}\n${setup.stderr || ''}`);
const turn = platformSpawnSync('claude', ['-p', 'Write the word LINE on 1000 separate lines, then on the final line write FIRST_DONE.', '--resume', sessionId, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], { encoding: 'utf8', timeout: 120000 });
console.log(JSON.stringify({
  sessionId,
  status: turn.status,
  signal: turn.signal,
  error: turn.error && String(turn.error.message || turn.error),
  stdoutPreview: extractClaudeText(turn.stdout || '').slice(0, 300),
  stderrPreview: (turn.stderr || '').slice(0, 500)
}, null, 2));
