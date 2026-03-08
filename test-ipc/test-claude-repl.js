const { spawn } = require('child_process');

console.log('Starting interactive claude...');

const claude = spawn('claude', [], {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
});

claude.stdout.on('data', (data) => {
    console.log(`[STDOUT]: ${data}`);
});

claude.stderr.on('data', (data) => {
    console.log(`[STDERR]: ${data}`);
});

claude.on('close', (code) => {
    console.log(`[CLOSE]: process exited with code ${code}`);
});

setTimeout(() => {
    console.log('Writing prompt...');
    claude.stdin.write('hi\n');
}, 3000);
