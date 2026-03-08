const { spawn } = require('child_process');

// Agent Client Protocol
const server = spawn('copilot', ['--acp'], {
    shell: process.platform === 'win32'
});

server.stdout.on('data', data => {
    console.log('[RECEIVE]', data.toString());
});

server.stderr.on('data', data => {
    console.error('[STDERR]', data.toString());
});

server.on('close', code => {
    console.log('[EXIT]', code);
});

// JSON-RPC JSON-lines message? Let's just try sending a random JSON 
setTimeout(() => {
    server.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
}, 1000);