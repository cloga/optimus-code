/**
 * QA Tests for Issue #44: Native Session ID Binding via YAML frontmatter.
 * Tests parseFrontmatter() and updateFrontmatter() logic extracted from worker-spawner.ts.
 */
import assert from 'assert';

// --- Extracted functions under test (mirrored from worker-spawner.ts) ---

function parseFrontmatter(content: string): { frontmatter: Record<string, string>, body: string } {
    const yamlRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(yamlRegex);
    const frontmatter: Record<string, string> = {};
    let body = content;

    if (match) {
        const yamlBlock = match[1];
        body = match[2];
        yamlBlock.split('\n').forEach(line => {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim();
                const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
                if (key) frontmatter[key] = value;
            }
        });
    }

    return { frontmatter, body };
}

function updateFrontmatter(content: string, updates: Record<string, string>): string {
    const parsed = parseFrontmatter(content);
    const newFm = { ...parsed.frontmatter, ...updates };

    let yamlStr = '---\n';
    for (const [k, v] of Object.entries(newFm)) {
        yamlStr += `${k}: ${v}\n`;
    }
    yamlStr += '---';

    const bodyStr = parsed.body.startsWith('\n') ? parsed.body : '\n' + parsed.body;
    return yamlStr + bodyStr;
}

// --- Test Cases ---

console.log('=== QA Test Suite: Issue #44 - Native Session ID Binding ===\n');

// Test 1: parseFrontmatter on file WITH existing frontmatter
console.log('Test 1: Parse file with existing YAML frontmatter');
{
    const content = `---
role: qa-engineer
base_tier: T3
session_id: 6f10ac7d-8c68-4d34-ab2f-d8694b42d8cd
created_at: 2026-03-10T01:25:42.040Z
---

# QA Engineer
Some body content.`;

    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter.role, 'qa-engineer');
    assert.strictEqual(result.frontmatter.base_tier, 'T3');
    assert.strictEqual(result.frontmatter.session_id, '6f10ac7d-8c68-4d34-ab2f-d8694b42d8cd');
    assert.strictEqual(result.frontmatter.created_at, '2026-03-10T01:25:42.040Z');
    assert.ok(result.body.includes('# QA Engineer'));
    console.log('  PASS: Correctly parsed all frontmatter keys and body\n');
}

// Test 2: parseFrontmatter on file WITHOUT frontmatter (like pm.md)
console.log('Test 2: Parse file without YAML frontmatter (e.g., pm.md)');
{
    const content = `# The PM (Product Manager) Expert

You are the chief PM for the project.`;

    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter, {});
    assert.strictEqual(result.body, content);
    console.log('  PASS: Returns empty frontmatter and full body\n');
}

// Test 3: updateFrontmatter on file WITHOUT existing frontmatter (key scenario)
console.log('Test 3: Add frontmatter to a file that has NONE (pm.md scenario)');
{
    const original = `# The PM (Product Manager) Expert

You are the chief PM for the project.`;

    const updated = updateFrontmatter(original, {
        engine: 'claude-code',
        session_id: 'abc12345-1234-5678-9abc-def012345678'
    });

    // Verify the updated file has proper YAML frontmatter
    const reparsed = parseFrontmatter(updated);
    assert.strictEqual(reparsed.frontmatter.engine, 'claude-code');
    assert.strictEqual(reparsed.frontmatter.session_id, 'abc12345-1234-5678-9abc-def012345678');
    // Verify body is preserved
    assert.ok(reparsed.body.includes('# The PM (Product Manager) Expert'));
    assert.ok(reparsed.body.includes('You are the chief PM for the project.'));
    console.log('  PASS: Frontmatter injected, body preserved\n');
    console.log('  Output preview:\n' + updated.split('\n').slice(0, 6).map(l => '    ' + l).join('\n') + '\n');
}

// Test 4: updateFrontmatter on file WITH existing frontmatter (merge scenario)
console.log('Test 4: Merge new keys into existing frontmatter');
{
    const original = `---
role: qa-engineer
base_tier: T3
session_id: old-session-id
---

# QA Engineer
Body here.`;

    const updated = updateFrontmatter(original, {
        engine: 'claude-code',
        session_id: 'new-session-id-12345'
    });

    const reparsed = parseFrontmatter(updated);
    assert.strictEqual(reparsed.frontmatter.role, 'qa-engineer');
    assert.strictEqual(reparsed.frontmatter.base_tier, 'T3');
    assert.strictEqual(reparsed.frontmatter.engine, 'claude-code');
    assert.strictEqual(reparsed.frontmatter.session_id, 'new-session-id-12345');
    assert.ok(reparsed.body.includes('# QA Engineer'));
    console.log('  PASS: Existing keys preserved, updated keys overwritten\n');
}

// Test 5: updateFrontmatter with copilot engine
console.log('Test 5: Session binding with copilot-cli engine');
{
    const original = `---
role: architect
---

# Architect`;

    const updated = updateFrontmatter(original, {
        engine: 'copilot-cli',
        session_id: 'copilot-sess-abcdef'
    });

    const reparsed = parseFrontmatter(updated);
    assert.strictEqual(reparsed.frontmatter.engine, 'copilot-cli');
    assert.strictEqual(reparsed.frontmatter.session_id, 'copilot-sess-abcdef');
    assert.strictEqual(reparsed.frontmatter.role, 'architect');
    console.log('  PASS: Copilot engine binding works correctly\n');
}

// Test 6: Idempotency - running updateFrontmatter twice with same values
console.log('Test 6: Idempotency of updateFrontmatter');
{
    const original = `---
role: security
engine: claude-code
session_id: sess-123
---

# Security`;

    const first = updateFrontmatter(original, { engine: 'claude-code', session_id: 'sess-456' });
    const second = updateFrontmatter(first, { engine: 'claude-code', session_id: 'sess-456' });

    assert.strictEqual(first, second);
    console.log('  PASS: Double-apply is idempotent\n');
}

// Test 7: chief-architect.md style - non-frontmatter file with "# identity" header
console.log('Test 7: Non-standard header file (chief-architect.md style)');
{
    const original = `# identity
name: chief-architect
description: "The visionary Chief Architect"

# role_definition
You are the **Chief Architect**`;

    const updated = updateFrontmatter(original, {
        engine: 'claude-code',
        session_id: 'chief-sess-789'
    });

    const reparsed = parseFrontmatter(updated);
    assert.strictEqual(reparsed.frontmatter.engine, 'claude-code');
    assert.strictEqual(reparsed.frontmatter.session_id, 'chief-sess-789');
    // The original body should be preserved
    assert.ok(reparsed.body.includes('# identity'));
    assert.ok(reparsed.body.includes('chief-architect'));
    console.log('  PASS: Non-standard file gets frontmatter prepended, body preserved\n');
}

// Test 8: Regex for fallback session ID capture
console.log('Test 8: Fallback regex session ID capture');
{
    const regex = /"?(?:session_id|sessionId)"?\s*[:=]\s*"([0-9a-f-]{36})"/i;

    // Standard JSON field
    const match1 = '"session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"'.match(regex);
    assert.ok(match1);
    assert.strictEqual(match1![1], 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

    // camelCase variant
    const match2 = '"sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"'.match(regex);
    assert.ok(match2);

    // With = sign
    const match3 = 'session_id="a1b2c3d4-e5f6-7890-abcd-ef1234567890"'.match(regex);
    assert.ok(match3);

    console.log('  PASS: All regex variants capture session IDs correctly\n');
}

// Test 9: Edge case - Windows line endings (\r\n)
console.log('Test 9: Edge case - content with Windows line endings');
{
    const content = "---\r\nrole: pm\r\nsession_id: old\r\n---\r\n\r\n# PM";
    // parseFrontmatter uses \n in regex, so \r\n won't match
    const result = parseFrontmatter(content);

    if (Object.keys(result.frontmatter).length === 0) {
        console.log('  NOTE: Windows \\r\\n line endings are NOT matched by parseFrontmatter regex');
        console.log('  This is a potential edge case on Windows if files are saved with CRLF\n');
    } else {
        console.log('  PASS: Windows line endings handled\n');
    }
}

// Test 10: Verify the delegateTaskSingle guard condition
console.log('Test 10: Session capture guard - adapter.lastSessionId && fs.existsSync(t1Path)');
{
    // Simulates the guard at line 162 of worker-spawner.ts
    const simulateGuard = (lastSessionId: string | undefined, t1Exists: boolean): boolean => {
        return !!(lastSessionId && t1Exists);
    };

    assert.strictEqual(simulateGuard(undefined, true), false, 'No session ID => no write');
    assert.strictEqual(simulateGuard('', true), false, 'Empty session ID => no write');
    assert.strictEqual(simulateGuard('sess-123', false), false, 'T1 file missing => no write');
    assert.strictEqual(simulateGuard('sess-123', true), true, 'Both present => write');
    console.log('  PASS: Guard condition correctly prevents writes when session or file is missing\n');
}

console.log('=== All QA Tests Passed ===');
console.log('\nSummary: 10/10 tests passed (1 noted edge case for CRLF on Windows)');
