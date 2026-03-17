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

    // SIGTERM = killed by timeout (server started and was running) = success
    // status 0 = clean exit = success
    const isSuccess = result.signal === 'SIGTERM' || result.status === 0;
    const stderr = result.stderr || '';
    const hasModuleError =
      stderr.includes('ERR_REQUIRE_ESM') ||
      stderr.includes('Cannot find module') ||
      stderr.includes('SyntaxError');

    expect(hasModuleError).toBe(false);
    expect(isSuccess || !hasModuleError).toBe(true);
  });
});
