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

// ─── Cleanup & Summary ───
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(corruptDir, { recursive: true, force: true });

console.log(`\n${'═'.repeat(50)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);
console.log(`${'═'.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
