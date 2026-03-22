import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runEntropyPatrol, formatPatrolReport } from '../harness/entropyPatrol';

describe('entropyPatrol', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entropy-test-'));
        // Create minimal .optimus structure
        fs.mkdirSync(path.join(tmpDir, '.optimus', 'roles'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, '.optimus', 'skills', 'test-skill'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, '.optimus', 'config'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, '.optimus', 'memory'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('passes on clean workspace', () => {
        // Write a valid role
        fs.writeFileSync(path.join(tmpDir, '.optimus', 'roles', 'builder.md'),
            '---\nrole: builder\ntier: T2\ndescription: Builds things\nengine: claude-code\n---\n' +
            Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: content here`).join('\n'));

        // Write a valid skill
        fs.writeFileSync(path.join(tmpDir, '.optimus', 'skills', 'test-skill', 'SKILL.md'),
            '---\nname: test-skill\ndescription: Test skill\n---\n# Test Skill\nStep 1\nStep 2\nStep 3\nStep 4\nStep 5');

        const report = runEntropyPatrol(tmpDir);
        expect(report.summary.errors).toBe(0);
    });

    it('detects role with missing fields', () => {
        fs.writeFileSync(path.join(tmpDir, '.optimus', 'roles', 'bad.md'),
            '---\ntier: T2\n---\n' + 'x\n'.repeat(30));

        const report = runEntropyPatrol(tmpDir);
        expect(report.summary.errors).toBeGreaterThan(0);
        expect(report.checks.find(c => c.name === 'structural-lint')?.status).toBe('error');
    });

    it('detects quarantined roles', () => {
        fs.writeFileSync(path.join(tmpDir, '.optimus', 'roles', 'broken.md'),
            '---\nrole: broken\ntier: T2\ndescription: test\nengine: x\nstatus: quarantined\n---\n' + 'x\n'.repeat(30));

        const report = runEntropyPatrol(tmpDir);
        const check = report.checks.find(c => c.name === 'quarantined-roles');
        expect(check?.status).toBe('warn');
        expect(check?.details).toContain('broken');
    });

    it('detects stale T1 agents', () => {
        fs.mkdirSync(path.join(tmpDir, '.optimus', 'agents'), { recursive: true });
        const agentFile = path.join(tmpDir, '.optimus', 'agents', 'old_agent_abc123.md');
        fs.writeFileSync(agentFile, '# Old agent');
        // Set mtime to 30 days ago
        const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        fs.utimesSync(agentFile, oldTime, oldTime);

        const report = runEntropyPatrol(tmpDir);
        const check = report.checks.find(c => c.name === 'stale-agents');
        expect(check?.status).toBe('warn');
        expect(check?.details).toContain('old_agent_abc123.md');
    });

    it('checks memory health', () => {
        fs.writeFileSync(path.join(tmpDir, '.optimus', 'memory', 'continuous-memory.md'),
            '---\nid: 1\n---\nSome memory entry\n---\nid: 2\n---\nAnother entry');

        const report = runEntropyPatrol(tmpDir);
        const check = report.checks.find(c => c.name === 'memory-health');
        expect(check?.status).toBe('pass');
    });

    it('formatPatrolReport produces readable output', () => {
        const report = runEntropyPatrol(tmpDir);
        const formatted = formatPatrolReport(report);
        expect(formatted).toContain('Entropy Patrol Report');
        expect(formatted).toContain('passed');
    });
});
