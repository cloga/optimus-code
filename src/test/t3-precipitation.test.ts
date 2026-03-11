/**
 * Test: T3→T2 Precipitation + T2→T1 Promotion Logic
 * 
 * Tests the pure logic functions without needing real LLM invocations.
 * Run: npx tsx src/test/t3-precipitation.test.ts
 */
import fs from "fs";
import path from "path";
import os from "os";

// ─── Inline the functions we want to test (avoid import issues with the full module) ───

function parseFrontmatter(content: string): { frontmatter: Record<string, string>, body: string } {
    const normalized = content.replace(/\r\n/g, '\n');
    const yamlRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = normalized.match(yamlRegex);
    let frontmatter: Record<string, string> = {};
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

interface T3UsageEntry {
    role: string; invocations: number; successes: number; failures: number;
    lastUsed: string; engine: string; model?: string;
}

function getT3UsageLogPath(wp: string): string {
    return path.join(wp, '.optimus', 'state', 't3-usage-log.json');
}
function loadT3UsageLog(wp: string): Record<string, T3UsageEntry> {
    const p = getT3UsageLogPath(wp);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    return {};
}
function saveT3UsageLog(wp: string, log: Record<string, T3UsageEntry>): void {
    const p = getT3UsageLogPath(wp);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(log, null, 2), 'utf8');
}
function trackT3Usage(wp: string, role: string, success: boolean, engine: string, model?: string): void {
    const log = loadT3UsageLog(wp);
    if (!log[role]) { log[role] = { role, invocations: 0, successes: 0, failures: 0, lastUsed: '', engine, model }; }
    log[role].invocations++;
    if (success) log[role].successes++; else log[role].failures++;
    log[role].lastUsed = new Date().toISOString();
    log[role].engine = engine;
    if (model) log[role].model = model;
    saveT3UsageLog(wp, log);
}
function checkAndPrecipitate(wp: string, role: string, engine: string, model?: string): string | null {
    const log = loadT3UsageLog(wp);
    const entry = log[role];
    if (!entry || entry.invocations < 3) return null;
    const successRate = entry.successes / entry.invocations;
    if (successRate < 0.8) return null;
    const t2Dir = path.join(wp, '.optimus', 'roles');
    const t2Path = path.join(t2Dir, `${role}.md`);
    if (fs.existsSync(t2Path)) return null;
    if (!fs.existsSync(t2Dir)) fs.mkdirSync(t2Dir, { recursive: true });
    const formattedRole = role.split(/[-_]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const template = `---\nrole: ${role}\ntier: T2\ndescription: "Auto-precipitated from T3 after ${entry.invocations} successful invocations"\nengine: ${engine}\nmodel: ${model || 'claude-opus-4.6-1m'}\nprecipitated: ${new Date().toISOString()}\n---\n\n# ${formattedRole}\n\nAuto-promoted from T3.\n`;
    fs.writeFileSync(t2Path, template, 'utf8');
    return t2Path;
}

// ─── Test Harness ───

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean) {
    if (condition) { console.log(`  ✅ PASS: ${label}`); passed++; }
    else { console.log(`  ❌ FAIL: ${label}`); failed++; }
}

// Create temp workspace
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-test-'));
console.log(`\n🧪 Test workspace: ${tmpDir}\n`);

// ─── TEST 1: T3 Usage Tracking ───
console.log('━━━ Test 1: T3 Usage Tracking ━━━');
trackT3Usage(tmpDir, 'security-auditor', true, 'claude-code', 'claude-opus-4.6-1m');
trackT3Usage(tmpDir, 'security-auditor', true, 'claude-code', 'claude-opus-4.6-1m');
let log = loadT3UsageLog(tmpDir);
assert('Tracks 2 invocations', log['security-auditor']?.invocations === 2);
assert('Tracks 2 successes', log['security-auditor']?.successes === 2);
assert('Tracks 0 failures', log['security-auditor']?.failures === 0);
assert('Records engine', log['security-auditor']?.engine === 'claude-code');
assert('Records model', log['security-auditor']?.model === 'claude-opus-4.6-1m');

// ─── TEST 2: No precipitation below threshold ───
console.log('\n━━━ Test 2: No Precipitation Below Threshold ━━━');
let result = checkAndPrecipitate(tmpDir, 'security-auditor', 'claude-code', 'claude-opus-4.6-1m');
assert('Does NOT precipitate at 2 invocations', result === null);
const t2Path = path.join(tmpDir, '.optimus', 'roles', 'security-auditor.md');
assert('No T2 file created', !fs.existsSync(t2Path));

// ─── TEST 3: Precipitation at threshold ───
console.log('\n━━━ Test 3: Precipitation at Threshold (3 invocations, 100% success) ━━━');
trackT3Usage(tmpDir, 'security-auditor', true, 'claude-code', 'claude-opus-4.6-1m');
result = checkAndPrecipitate(tmpDir, 'security-auditor', 'claude-code', 'claude-opus-4.6-1m');
assert('Precipitates at 3 invocations', result !== null);
assert('T2 file created', fs.existsSync(t2Path));
const t2Content = fs.readFileSync(t2Path, 'utf8');
const fm = parseFrontmatter(t2Content);
assert('Frontmatter has role', fm.frontmatter.role === 'security-auditor');
assert('Frontmatter has tier T2', fm.frontmatter.tier === 'T2');
assert('Frontmatter has engine binding', fm.frontmatter.engine === 'claude-code');
assert('Frontmatter has model binding', fm.frontmatter.model === 'claude-opus-4.6-1m');
assert('Frontmatter has precipitated timestamp', !!fm.frontmatter.precipitated);

// ─── TEST 4: No duplicate precipitation ───
console.log('\n━━━ Test 4: No Duplicate Precipitation ━━━');
trackT3Usage(tmpDir, 'security-auditor', true, 'claude-code');
result = checkAndPrecipitate(tmpDir, 'security-auditor', 'claude-code');
assert('Does NOT re-precipitate existing T2', result === null);

// ─── TEST 5: Low success rate does NOT precipitate ───
console.log('\n━━━ Test 5: Low Success Rate (below 80%) ━━━');
trackT3Usage(tmpDir, 'flaky-role', true, 'claude-code');
trackT3Usage(tmpDir, 'flaky-role', false, 'claude-code');
trackT3Usage(tmpDir, 'flaky-role', false, 'claude-code');
result = checkAndPrecipitate(tmpDir, 'flaky-role', 'claude-code');
assert('Does NOT precipitate at 33% success rate', result === null);
const flakyPath = path.join(tmpDir, '.optimus', 'roles', 'flaky-role.md');
assert('No T2 file for flaky role', !fs.existsSync(flakyPath));

// ─── TEST 6: Boundary — exactly 80% success ───
console.log('\n━━━ Test 6: Boundary — Exactly 80% Success Rate ━━━');
for (let i = 0; i < 4; i++) trackT3Usage(tmpDir, 'boundary-role', true, 'copilot-cli', 'gpt-5.4');
trackT3Usage(tmpDir, 'boundary-role', false, 'copilot-cli', 'gpt-5.4');
log = loadT3UsageLog(tmpDir);
assert('5 invocations, 4 successes (80%)', log['boundary-role']?.invocations === 5 && log['boundary-role']?.successes === 4);
result = checkAndPrecipitate(tmpDir, 'boundary-role', 'copilot-cli', 'gpt-5.4');
assert('Precipitates at exactly 80%', result !== null);
const boundaryFm = parseFrontmatter(fs.readFileSync(path.join(tmpDir, '.optimus', 'roles', 'boundary-role.md'), 'utf8'));
assert('Uses copilot-cli engine', boundaryFm.frontmatter.engine === 'copilot-cli');
assert('Uses gpt-5.4 model', boundaryFm.frontmatter.model === 'gpt-5.4');

// ─── TEST 7: T2 Frontmatter Reading (existing roles) ───
console.log('\n━━━ Test 7: T2 Frontmatter Engine/Model Reading ━━━');
const realChiefArchitect = fs.readFileSync(path.join(process.cwd(), '.optimus', 'roles', 'chief-architect.md'), 'utf8');
const caFm = parseFrontmatter(realChiefArchitect);
assert('chief-architect has engine in frontmatter', caFm.frontmatter.engine === 'claude-code');
assert('chief-architect has model in frontmatter', caFm.frontmatter.model === 'claude-opus-4.6-1m');
const realQa = fs.readFileSync(path.join(process.cwd(), '.optimus', 'roles', 'qa-engineer.md'), 'utf8');
const qaFm = parseFrontmatter(realQa);
assert('qa-engineer has engine in frontmatter', qaFm.frontmatter.engine === 'claude-code');
assert('qa-engineer has model in frontmatter', qaFm.frontmatter.model === 'claude-opus-4.6-1m');

// ─── TEST 8: Corrupted JSON resilience ───
console.log('\n━━━ Test 8: Corrupted JSON Resilience ━━━');
const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-corrupt-'));
const corruptLogDir = path.join(corruptDir, '.optimus', 'state');
fs.mkdirSync(corruptLogDir, { recursive: true });
fs.writeFileSync(path.join(corruptLogDir, 't3-usage-log.json'), '{invalid json!!!', 'utf8');
const corruptLog = loadT3UsageLog(corruptDir);
assert('Handles corrupted JSON gracefully (returns empty)', Object.keys(corruptLog).length === 0);
// Should not throw
trackT3Usage(corruptDir, 'test-role', true, 'claude-code');
const fixedLog = loadT3UsageLog(corruptDir);
assert('Overwrites corrupted log with valid data', fixedLog['test-role']?.invocations === 1);

// ─── TEST 9: T3→T2→T1 Hierarchy Integrity ───
console.log('\n━━━ Test 9: T3→T2→T1 Hierarchy Integrity ━━━');
const rolesDir = path.join(process.cwd(), '.optimus', 'roles');
const agentsDir = path.join(process.cwd(), '.optimus', 'agents');
const t2Files = fs.readdirSync(rolesDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
const t1Files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
assert(`T2 role count (${t2Files.length}) >= T1 agent count (${t1Files.length})`, t2Files.length >= t1Files.length);

// Every T1 agent MUST have a corresponding T2 role template
const missingT2 = t1Files.filter(a => !t2Files.includes(a));
assert(`All T1 agents have T2 templates (missing: ${missingT2.length > 0 ? missingT2.join(', ') : 'none'})`, missingT2.length === 0);

// ─── TEST 10: All T2 Roles Have Required Frontmatter (engine/model optional) ───
console.log('\n━━━ Test 10: All T2 Roles Have Required Frontmatter ━━━');
for (const role of t2Files) {
    const content = fs.readFileSync(path.join(rolesDir, `${role}.md`), 'utf8');
    const fm = parseFrontmatter(content);
    assert(`T2 "${role}" has role field`, !!fm.frontmatter.role);
    assert(`T2 "${role}" has tier field`, !!fm.frontmatter.tier);
    // engine/model are OPTIONAL — system fallback resolves from available-agents.json or defaults to claude-code
    if (fm.frontmatter.engine) {
        assert(`T2 "${role}" engine is valid`, ['claude-code', 'copilot-cli', 'deepseek-local'].includes(fm.frontmatter.engine));
    }
}

// ─── TEST 10b: Engine/Model Fallback Logic ───
console.log('\n━━━ Test 10b: Engine/Model Fallback from available-agents.json ━━━');
const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-fallback-'));
const fbConfigDir = path.join(fallbackDir, '.optimus', 'config');
fs.mkdirSync(fbConfigDir, { recursive: true });
// Write a mock available-agents.json
fs.writeFileSync(path.join(fbConfigDir, 'available-agents.json'), JSON.stringify({
    engines: {
        "copilot-cli": { available_models: ["gpt-5.4", "o3-mini"] },
        "claude-code": { available_models: ["claude-opus-4.6-1m"] },
        "deepseek-local": { available_models: ["deepseek-r1"], status: "demo" }
    }
}), 'utf8');
// Simulate the fallback logic inline
function resolveEngineFallback(workspacePath: string): { engine: string, model?: string } {
    const configPath = path.join(workspacePath, '.optimus', 'config', 'available-agents.json');
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const engines = Object.keys(config.engines || {}).filter(
                (e: string) => !config.engines[e].status?.includes('demo')
            );
            if (engines.length > 0) {
                const engine = engines[0];
                const models = config.engines[engine]?.available_models;
                const model = Array.isArray(models) && models.length > 0 ? models[0] : undefined;
                return { engine, model };
            }
        }
    } catch {}
    return { engine: 'claude-code' };
}
const fb = resolveEngineFallback(fallbackDir);
assert('Fallback picks first non-demo engine', fb.engine === 'copilot-cli');
assert('Fallback picks first model from engine', fb.model === 'gpt-5.4');
// Test with no config
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-empty-'));
const fbEmpty = resolveEngineFallback(emptyDir);
assert('Ultimate fallback is claude-code', fbEmpty.engine === 'claude-code');
assert('No model when no config', fbEmpty.model === undefined);

// ─── TEST 11: T3→T2 Full Lifecycle Simulation ───
console.log('\n━━━ Test 11: T3→T2 Full Lifecycle (new role end-to-end) ━━━');
const lifecycleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-lifecycle-'));
const lcRolesDir = path.join(lifecycleDir, '.optimus', 'roles');
const lcAgentsDir = path.join(lifecycleDir, '.optimus', 'agents');
fs.mkdirSync(lcRolesDir, { recursive: true });
fs.mkdirSync(lcAgentsDir, { recursive: true });

// Phase 1: T3 dynamic role used 3 times successfully
const testRole = 'data-engineer';
trackT3Usage(lifecycleDir, testRole, true, 'claude-code', 'claude-opus-4.6-1m');
trackT3Usage(lifecycleDir, testRole, true, 'claude-code', 'claude-opus-4.6-1m');
trackT3Usage(lifecycleDir, testRole, true, 'claude-code', 'claude-opus-4.6-1m');
assert('T3 usage logged (3 invocations)', loadT3UsageLog(lifecycleDir)[testRole]?.invocations === 3);

// Phase 2: Auto-precipitate T3→T2
const t2Result = checkAndPrecipitate(lifecycleDir, testRole, 'claude-code', 'claude-opus-4.6-1m');
assert('T3→T2 precipitation triggered', t2Result !== null);
const t2RolePath = path.join(lcRolesDir, `${testRole}.md`);
assert('T2 role file created', fs.existsSync(t2RolePath));

// Phase 3: Verify T2 template quality
const t2Template = fs.readFileSync(t2RolePath, 'utf8');
const t2Fm = parseFrontmatter(t2Template);
assert('T2 template has correct role', t2Fm.frontmatter.role === testRole);
assert('T2 template has tier T2', t2Fm.frontmatter.tier === 'T2');
assert('T2 template has engine binding', t2Fm.frontmatter.engine === 'claude-code');
assert('T2 template has model binding', t2Fm.frontmatter.model === 'claude-opus-4.6-1m');
assert('T2 template has precipitated timestamp', !!t2Fm.frontmatter.precipitated);
assert('T2 body contains formatted role name', t2Fm.body.includes('Data Engineer'));

// Phase 4: Simulate T2→T1 instantiation (create T1 from T2 with session state)
const t1Content = `---
role: ${testRole}
base_tier: T1
engine: ${t2Fm.frontmatter.engine}
model: ${t2Fm.frontmatter.model}
session_id: test-session-${Date.now()}
created_at: ${new Date().toISOString()}
---

# [Local Instance] ${testRole}
This persona is a T1 Local Project Expert instantiated from the T2 template.
`;
const t1AgentPath = path.join(lcAgentsDir, `${testRole}.md`);
fs.writeFileSync(t1AgentPath, t1Content, 'utf8');
assert('T1 agent file created from T2', fs.existsSync(t1AgentPath));

// Phase 5: Final hierarchy validation
const lcT2 = fs.readdirSync(lcRolesDir).filter(f => f.endsWith('.md'));
const lcT1 = fs.readdirSync(lcAgentsDir).filter(f => f.endsWith('.md'));
assert('Lifecycle: T2 >= T1', lcT2.length >= lcT1.length);
const t1Fm = parseFrontmatter(fs.readFileSync(t1AgentPath, 'utf8'));
assert('T1 inherits engine from T2', t1Fm.frontmatter.engine === t2Fm.frontmatter.engine);
assert('T1 inherits model from T2', t1Fm.frontmatter.model === t2Fm.frontmatter.model);
assert('T1 has session_id (instance state)', !!t1Fm.frontmatter.session_id);

// ─── TEST 12: Sanitize role names (path traversal prevention) ───
console.log('\n━━━ Test 12: Role Name Sanitization ━━━');
function sanitizeRoleName(role: string): string {
    return role.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100);
}
assert('Normal role unchanged', sanitizeRoleName('chief-architect') === 'chief-architect');
assert('Strips dots', sanitizeRoleName('../escape') === 'escape');
assert('Strips slashes', sanitizeRoleName('../../config/steal') === 'configsteal');
assert('Strips spaces', sanitizeRoleName('my role') === 'myrole');
assert('Preserves underscores', sanitizeRoleName('web_dev_expert') === 'web_dev_expert');
assert('Truncates long names', sanitizeRoleName('a'.repeat(200)).length === 100);

// ─── Cleanup & Summary ───
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(corruptDir, { recursive: true, force: true });
fs.rmSync(lifecycleDir, { recursive: true, force: true });
fs.rmSync(fallbackDir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\n${'═'.repeat(50)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
console.log(`${'═'.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
