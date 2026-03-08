const { execSync } = require('child_process');

console.log('Testing Auto-loop:');
try {
    const t1 = execSync('claude -p "Create three text files named a.txt, b.txt, and c.txt, and put a number in each. Tell me when done." --dangerously-skip-permissions', { encoding: 'utf8' });
    console.log(t1);
} catch (e) {
    console.log(e.stdout, e.stderr);
}
