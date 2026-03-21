const fs = require('fs');
const path = require('path');

const CANONICAL_CONFIG_PATH = path.join('.optimus', 'config', 'mcp-servers.json');
const WORKSPACE_TOKEN = '${workspaceRoot}';
const TARGET_FILES = {
  vscode: { relativePath: path.join('.vscode', 'mcp.json'), rootKey: 'servers', includeInputs: true },
  copilot: { relativePath: path.join('.copilot', 'mcp-config.json'), rootKey: 'mcpServers', includeInputs: false },
  claude: { relativePath: '.mcp.json', rootKey: 'mcpServers', includeInputs: false }
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  const result = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function createDefaultCanonicalConfig() {
  return {
    version: 1,
    servers: {
      'spartan-swarm': {
        type: 'stdio',
        command: 'node',
        args: [`${WORKSPACE_TOKEN}/.optimus/dist/mcp-server.js`],
        env: {
          OPTIMUS_WORKSPACE_ROOT: WORKSPACE_TOKEN,
          DOTENV_PATH: `${WORKSPACE_TOKEN}/.env`
        },
        clients: {
          vscode: {
            env: {
              PATH: '${env:PATH}'
            }
          }
        }
      }
    }
  };
}

function loadCanonicalMcpConfig(workspaceRoot) {
  const configPath = path.join(workspaceRoot, CANONICAL_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return createDefaultCanonicalConfig();
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (raw && typeof raw === 'object') {
    return raw;
  }
  return createDefaultCanonicalConfig();
}

function renderString(value, target, workspaceRoot) {
  if (value === WORKSPACE_TOKEN) {
    if (target === 'vscode') return '${workspaceFolder}';
    if (target === 'runtime') return workspaceRoot;
    return '.';
  }

  if (value.startsWith(`${WORKSPACE_TOKEN}/`)) {
    const suffix = value.slice(WORKSPACE_TOKEN.length + 1);
    if (target === 'vscode') {
      return `\${workspaceFolder}/${suffix}`;
    }
    if (target === 'runtime') {
      return path.join(workspaceRoot, ...suffix.split('/'));
    }
    return `./${suffix}`;
  }

  return value.replace(/\$\{env:([^}]+)\}/g, (_, name) => {
    if (target === 'vscode') {
      return `\${env:${name}}`;
    }
    return process.env[name] || '';
  });
}

function renderValue(value, target, workspaceRoot) {
  if (Array.isArray(value)) {
    return value.map(item => renderValue(item, target, workspaceRoot));
  }

  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? renderString(value, target, workspaceRoot) : value;
  }

  const rendered = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'clients') continue;
    rendered[key] = renderValue(nested, target, workspaceRoot);
  }
  return rendered;
}

function renderServersForTarget(config, target, workspaceRoot) {
  const rawServers = config.servers || config.mcpServers || {};
  const rendered = {};

  for (const [name, server] of Object.entries(rawServers)) {
    const base = deepMerge({}, server);
    const clientOverride = server && server.clients && typeof server.clients === 'object'
      ? server.clients[target]
      : undefined;
    const merged = clientOverride ? deepMerge(base, clientOverride) : base;
    delete merged.clients;
    rendered[name] = renderValue(merged, target, workspaceRoot);
  }

  return rendered;
}

function readExistingConfig(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

function mergeTargetConfig(existing, target, renderedServers) {
  const spec = TARGET_FILES[target];
  const result = existing && typeof existing === 'object' ? { ...existing } : {};
  const fallbackKey = target === 'vscode' ? 'mcpServers' : 'servers';
  const key = result[spec.rootKey] && typeof result[spec.rootKey] === 'object'
    ? spec.rootKey
    : result[fallbackKey] && typeof result[fallbackKey] === 'object'
      ? fallbackKey
      : spec.rootKey;

  result[key] = {
    ...(result[key] || {}),
    ...renderedServers
  };

  if (spec.includeInputs && !Array.isArray(result.inputs)) {
    result.inputs = [];
  }

  return result;
}

function writeClientMcpConfigs(workspaceRoot) {
  const config = loadCanonicalMcpConfig(workspaceRoot);

  for (const [target, spec] of Object.entries(TARGET_FILES)) {
    const targetPath = path.join(workspaceRoot, spec.relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const renderedServers = renderServersForTarget(config, target, workspaceRoot);
    const merged = mergeTargetConfig(readExistingConfig(targetPath), target, renderedServers);
    fs.writeFileSync(targetPath, JSON.stringify(merged, null, 4) + '\n', 'utf8');
  }
}

module.exports = {
  CANONICAL_CONFIG_PATH,
  createDefaultCanonicalConfig,
  loadCanonicalMcpConfig,
  renderServersForTarget,
  writeClientMcpConfigs
};
