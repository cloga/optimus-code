import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractBestFrontmatterDocument, getLockManager, resetLockManagerCacheForTests } from '../mcp/worker-spawner';

const createdWorkspaceRoots: string[] = [];

function createWorkspaceRoot(label: string): string {
    const workspaceRoot = path.join(
        process.cwd(),
        `.worker-lock-manager-scope-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fs.mkdirSync(path.join(workspaceRoot, '.optimus', 'agents'), { recursive: true });
    createdWorkspaceRoots.push(workspaceRoot);
    return workspaceRoot;
}

afterEach(() => {
    resetLockManagerCacheForTests();
    while (createdWorkspaceRoots.length > 0) {
        const workspaceRoot = createdWorkspaceRoots.pop();
        if (workspaceRoot) {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    }
});

describe('getLockManager', () => {
    it('reuses the same manager for equivalent workspace paths', () => {
        const workspaceRoot = createWorkspaceRoot('same');

        const first = getLockManager(workspaceRoot);
        const second = getLockManager(path.join(workspaceRoot, '.'));

        expect(second).toBe(first);
    });

    it('scopes managers by workspace path', () => {
        const firstWorkspace = createWorkspaceRoot('first');
        const secondWorkspace = createWorkspaceRoot('second');

        const firstManager = getLockManager(firstWorkspace);
        const secondManager = getLockManager(secondWorkspace);

        expect(secondManager).not.toBe(firstManager);
        expect(getLockManager(firstWorkspace)).toBe(firstManager);
        expect(getLockManager(secondWorkspace)).toBe(secondManager);
    });
});

describe('extractBestFrontmatterDocument', () => {
    it('selects a bounded matching role document without swallowing earlier transcript content', () => {
        const response = `Tool transcript before the template.
---
role: security
tier: T2
description: "Thin draft"
engine: github-copilot
---
This is noisy transcript content that should not become part of the selected role.
It contains many lines that used to inflate candidate scoring.
Line 1
Line 2
Line 3
---
role: security
tier: T2
description: "Security engineer"
engine: github-copilot
model: gpt-5.4
---
# Security
## Core Responsibilities
- Review authentication and authorization boundaries.
- Review secret handling and logging risk.
## Workflow
- Produce actionable security findings.
`;

        const extracted = extractBestFrontmatterDocument(
            response,
            'security',
            '.optimus/roles/security.md',
            '.optimus/roles/security.md',
        );

        expect(extracted?.frontmatter.description).toBe('Security engineer');
        expect(extracted?.body).toContain('# Security');
        expect(extracted?.body).not.toContain('Tool transcript');
        expect(extracted?.body).not.toContain('noisy transcript content');
    });
});
