const { spawn } = require('child_process');

console.log('Testing JSON stream with stdin.end()...');
const claude = spawn('claude', [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions'
], {
    cwd: process.cwd(),
    shell: process.platform === 'win32'
});

claude.stdout.on('data', data => {
    console.log('[STDOUT RAW chunks]:\n', data.toString());
});

claude.stderr.on('data', data => {
    console.error('[STDERR]:', data.toString());
});

claude.on('close', code => {
    console.log('[EXIT]', code);
});

const inputPayload = JSON.stringify({
    type: 'message',
    text: 'Create a text file called teststream.txt and write hello in it, then read it back.'
});

claude.stdin.write(inputPayload + '\n');
claude.stdin.end();  // THIS is what was missing!
