const { spawn } = require('child_process');

console.log('Testing JSON stream with prompt argument...');
const claude = spawn('claude', [
    '-p', 'Create a text file called teststream_arg.txt with world inside',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
], {
    cwd: process.cwd(),
    shell: process.platform === 'win32'
});

claude.stdout.on('data', data => {
    console.log('[STDOUT RAW]:', data.toString());
});

claude.stderr.on('data', data => {
    console.error('[STDERR RAW]:', data.toString());
});

claude.on('close', code => {
    console.log('[EXIT]', code);
});
