const { execSync } = require('child_process');

console.log('Turn 1:');
try {
    const t1 = execSync('claude -p "Please remember the secret code: 7788" --dangerously-skip-permissions', { encoding: 'utf8' });
    console.log(t1);
} catch (e) {
    console.log(e.stdout, e.stderr);
}

console.log('Turn 2:');
try {
    const t2 = execSync('claude -c -p "What was the secret code?" --dangerously-skip-permissions', { encoding: 'utf8' });
    console.log(t2);
} catch (e) {
    console.log(e.stdout, e.stderr);
}
