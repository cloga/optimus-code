const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const UPDATE_REQUEST_TIMEOUT_MS = 1500;
const LATEST_RELEASE_URL = 'https://api.github.com/repos/cloga/optimus-code/releases/latest';

function getInstalledVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  return pkg.version;
}

function getUpdateCachePath() {
  return path.join(os.homedir(), '.optimus', 'update-check.json');
}

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

function parseVersion(version) {
  const normalized = normalizeVersion(version);
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    return null;
  }

  return normalized.split('.').map(part => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) {
    return 0;
  }

  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }

  return 0;
}

function isNewerVersion(latestVersion, currentVersion) {
  return compareVersions(latestVersion, currentVersion) > 0;
}

function shouldCheckForUpdates(cache, now = Date.now()) {
  if (!cache || typeof cache.checkedAt !== 'number') {
    return true;
  }

  return now - cache.checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

function readUpdateCache(cachePath = getUpdateCachePath()) {
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return {
      checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : '',
      releaseUrl: typeof parsed.releaseUrl === 'string' ? parsed.releaseUrl : ''
    };
  } catch {
    return null;
  }
}

function saveUpdateCache(cache, cachePath = getUpdateCachePath()) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  fs.renameSync(tempPath, cachePath);
}

function fetchLatestReleaseVersion(timeoutMs = UPDATE_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const request = https.get(LATEST_RELEASE_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'optimus-swarm-update-check'
      }
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub release lookup failed with status ${response.statusCode}`));
        return;
      }

      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({
            latestVersion: normalizeVersion(parsed.tag_name),
            releaseUrl: parsed.html_url || 'https://github.com/cloga/optimus-code/releases/latest'
          });
        } catch {
          reject(new Error('GitHub release lookup returned invalid JSON'));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`GitHub release lookup timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

function formatUpdateNotice(currentVersion, latestVersion, releaseUrl) {
  return [
    '',
    `↑ Update available: optimus-swarm v${latestVersion} (installed: v${currentVersion})`,
    '  Upgrade with: npx github:cloga/optimus-code upgrade',
    `  Release notes: ${releaseUrl}`,
    ''
  ].join('\n');
}

async function maybeNotifyAboutUpdate(command, options = {}) {
  if (command === 'serve' || process.env.OPTIMUS_SKIP_UPDATE_CHECK === '1') {
    return false;
  }

  const currentVersion = options.currentVersion || getInstalledVersion();
  const now = options.now || Date.now();
  const cachePath = options.cachePath || getUpdateCachePath();
  const write = typeof options.write === 'function'
    ? options.write
    : message => process.stderr.write(message);

  const cached = readUpdateCache(cachePath);
  let notified = false;

  if (cached && isNewerVersion(cached.latestVersion, currentVersion)) {
    write(formatUpdateNotice(currentVersion, cached.latestVersion, cached.releaseUrl));
    notified = true;
  }

  if (!shouldCheckForUpdates(cached, now)) {
    return notified;
  }

  try {
    const latest = await fetchLatestReleaseVersion(options.timeoutMs || UPDATE_REQUEST_TIMEOUT_MS);
    saveUpdateCache({
      checkedAt: now,
      latestVersion: latest.latestVersion,
      releaseUrl: latest.releaseUrl
    }, cachePath);

    if (!notified && isNewerVersion(latest.latestVersion, currentVersion)) {
      write(formatUpdateNotice(currentVersion, latest.latestVersion, latest.releaseUrl));
      return true;
    }
  } catch {
    return notified;
  }

  return notified;
}

module.exports = {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_REQUEST_TIMEOUT_MS,
  compareVersions,
  fetchLatestReleaseVersion,
  formatUpdateNotice,
  getInstalledVersion,
  getUpdateCachePath,
  isNewerVersion,
  maybeNotifyAboutUpdate,
  normalizeVersion,
  parseVersion,
  readUpdateCache,
  saveUpdateCache,
  shouldCheckForUpdates
};
