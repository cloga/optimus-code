const { spawn } = require('child_process');
const readline = require('readline');

// We use claude with stream-json
const claude = spawn('claude', [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
], {
    cwd: process.cwd(),
    shell: process.platform === 'win32'
});

console.log(`[Host] Spawned Claude PID: ${claude.pid}`);

claude.stdout.on('data', (data) => {
    console.log(`[Host] STDOUT RAW: ${data.toString()}`);
});

claude.stderr.on('data', (data) => {
    console.error(`[Host] STDERR: ${data.toString()}`);
});

claude.on('close', (code) => {
    console.log(`\n[Host] Claude child process exited with code ${code}`);
});

function sendPrompt(text) {
    console.log(`\n[Host] Sending prompt: "${text}"`);
    const inputPayload = JSON.stringify({
        type: 'message',
        text: text
    });
    claude.stdin.write(inputPayload + '\n');
}

// Initial prompt
sendPrompt('Hello, who are you? Please keep it very short.');