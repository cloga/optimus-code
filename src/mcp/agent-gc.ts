import * as fs from 'fs';
import * as path from 'path';

/**
 * Garbage-collect stale T1 agent instances.
 * Scans .optimus/agents/*.md, deletes files where last_invoked > maxAgeDays
 * or last_invoked is missing. Skips files with `persistent: true`.
 */
export function cleanStaleAgents(workspacePath: string, maxAgeDays: number = 7): void {
    const agentsDir = path.join(workspacePath, '.optimus', 'agents');
    if (!fs.existsSync(agentsDir)) return;

    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
        // Skip .lock files
        if (file.endsWith('.lock')) continue;

        const filePath = path.join(agentsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');

        // Parse frontmatter manually (simple key-value)
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const lines = fmMatch[1].split('\n');
        const getValue = (key: string) => {
            const line = lines.find(l => l.startsWith(`${key}:`));
            return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : undefined;
        };

        // Skip persistent agents
        if (getValue('persistent') === 'true') continue;

        // Check last_invoked (or fall back to created_at)
        const lastInvoked = getValue('last_invoked') || getValue('created_at');
        if (!lastInvoked) {
            // No timestamp at all — delete
            fs.unlinkSync(filePath);
            console.error(`[Agent GC] Removed stale T1 instance '${file}' (no timestamp found)`);
            continue;
        }

        const age = now - new Date(lastInvoked).getTime();
        if (age > maxAgeMs) {
            fs.unlinkSync(filePath);
            console.error(`[Agent GC] Removed stale T1 instance '${file}' (last invoked: ${lastInvoked})`);
        }
    }
}
