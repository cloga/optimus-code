import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const updateNotifier = require('../../optimus-plugin/bin/lib/update-notifier.js');

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  delete process.env.OPTIMUS_SKIP_UPDATE_CHECK;
});

describe('update notifier helpers', () => {
  it('compares semver versions numerically', () => {
    expect(updateNotifier.compareVersions('2.17.10', '2.17.9')).toBeGreaterThan(0);
    expect(updateNotifier.compareVersions('v2.17.8', '2.17.8')).toBe(0);
    expect(updateNotifier.compareVersions('2.17.7', '2.17.8')).toBeLessThan(0);
  });

  it('checks for updates when cache is missing or stale', () => {
    const now = Date.now();
    expect(updateNotifier.shouldCheckForUpdates(null, now)).toBe(true);
    expect(updateNotifier.shouldCheckForUpdates({
      checkedAt: now - updateNotifier.UPDATE_CHECK_INTERVAL_MS + 1000
    }, now)).toBe(false);
    expect(updateNotifier.shouldCheckForUpdates({
      checkedAt: now - updateNotifier.UPDATE_CHECK_INTERVAL_MS - 1000
    }, now)).toBe(true);
  });

  it('persists cache entries', () => {
    const cacheDir = makeTempDir('optimus-update-cache-');
    const cachePath = path.join(cacheDir, 'update-check.json');

    updateNotifier.saveUpdateCache({
      checkedAt: 123,
      latestVersion: '2.17.9',
      releaseUrl: 'https://example.test/release'
    }, cachePath);

    expect(updateNotifier.readUpdateCache(cachePath)).toEqual({
      checkedAt: 123,
      latestVersion: '2.17.9',
      releaseUrl: 'https://example.test/release'
    });
  });

  it('formats a clear update notice', () => {
    const message = updateNotifier.formatUpdateNotice('2.17.8', '2.17.9', 'https://example.test/release');
    expect(message).toContain('Update available: optimus-swarm v2.17.9');
    expect(message).toContain('installed: v2.17.8');
    expect(message).toContain('npx github:cloga/optimus-code upgrade');
    expect(message).toContain('https://example.test/release');
  });

  it('shows cached update notices without needing a fresh network check', async () => {
    const cacheDir = makeTempDir('optimus-update-notify-');
    const cachePath = path.join(cacheDir, 'update-check.json');
    const writes: string[] = [];

    updateNotifier.saveUpdateCache({
      checkedAt: Date.now(),
      latestVersion: '2.17.9',
      releaseUrl: 'https://example.test/release'
    }, cachePath);

    const notified = await updateNotifier.maybeNotifyAboutUpdate('go', {
      cachePath,
      currentVersion: '2.17.8',
      now: Date.now(),
      write: (message: string) => {
        writes.push(message);
      }
    });

    expect(notified).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('v2.17.9');
  });

  it('skips notifications for serve mode', async () => {
    const writes: string[] = [];

    const notified = await updateNotifier.maybeNotifyAboutUpdate('serve', {
      currentVersion: '2.17.8',
      write: (message: string) => {
        writes.push(message);
      }
    });

    expect(notified).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
