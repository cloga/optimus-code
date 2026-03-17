import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('mcp-server bundle', () => {
  it('loads without ERR_REQUIRE_ESM or module errors', () => {
    const bundlePath = path.resolve(__dirname, '../../optimus-plugin/dist/mcp-server.js');
    const escapedPath = bundlePath.replace(/\\/g, '\\\\');
    const result = spawnSync('node', ['-e', `require('${escapedPath}')`], {
      timeout: 3000,
      encoding: 'utf8',
    });

    // Primary check: no module resolution errors (ERR_REQUIRE_ESM, Cannot find module, SyntaxError)
    const stderr = result.stderr || '';
    const hasModuleError =
      stderr.includes('ERR_REQUIRE_ESM') ||
      stderr.includes('Cannot find module') ||
      stderr.includes('SyntaxError');

    // SIGTERM = server started and was killed by timeout = success
    // status 0 = clean exit = success
    // status 1 = runtime error (e.g. missing config/env) — acceptable for headless test
    // The critical failure mode is module errors, not runtime config errors
    expect(hasModuleError).toBe(false);
  });
});
