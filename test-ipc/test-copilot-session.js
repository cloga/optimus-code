const { execSync } = require('child_process');

console.log('--- COPILOT SESSION TEST ---');

console.log('\nTurn 1 (Prompt):');
try {
    const t1 = execSync('copilot -p "Please remember the secret code: XAE-123. Acknowledge with just the code." --resume cfc9a830-3d30-44c9-9ad0-8372b2ccaa54 --allow-all-tools', { encoding: 'utf8', env: process.env });
    console.log(t1.trim());
} catch (e) {
    console.log('Error 1:', e.stdout);
}

console.log('\nTurn 2 (Retrieve):');
try {
    const t2 = execSync('copilot -p "What was the secret code I just told you?" --resume cfc9a830-3d30-44c9-9ad0-8372b2ccaa54 --allow-all-tools', { encoding: 'utf8', env: process.env });
    console.log(t2.trim());
} catch (e) {
    console.log('Error 2:', e.stdout);
}
