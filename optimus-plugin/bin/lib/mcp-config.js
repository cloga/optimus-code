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

function writeCopilotLaunchers(workspaceRoot) {
  const ps1Path = path.join(workspaceRoot, 'copilot-optimus.ps1');
  const cmdPath = path.join(workspaceRoot, 'copilot-optimus.cmd');
  const shPath = path.join(workspaceRoot, 'copilot-optimus');

  const ps1Content = `param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $repoRoot '.copilot\\mcp-config.json'

if (-not (Test-Path $configPath)) {
    Write-Error "Missing Copilot MCP config: $configPath\`nRun 'optimus init' or 'optimus upgrade' first."
    exit 1
}

Push-Location $repoRoot
try {
    & copilot '--additional-mcp-config' "@$configPath" @Args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
`;

  const cmdContent = `@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0copilot-optimus.ps1" %*
exit /b %ERRORLEVEL%
`;

  const shContent = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CONFIG_PATH="$SCRIPT_DIR/.copilot/mcp-config.json"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Missing Copilot MCP config: $CONFIG_PATH" >&2
  echo "Run 'optimus init' or 'optimus upgrade' first." >&2
  exit 1
fi

cd "$SCRIPT_DIR"
exec copilot --additional-mcp-config "@$CONFIG_PATH" "$@"
`;

  fs.writeFileSync(ps1Path, ps1Content, 'utf8');
  fs.writeFileSync(cmdPath, cmdContent, 'utf8');
  fs.writeFileSync(shPath, shContent, 'utf8');

  try {
    fs.chmodSync(shPath, 0o755);
  } catch {
    // Ignore chmod failures on platforms/filesystems that do not support it.
  }
}

module.exports = {
  CANONICAL_CONFIG_PATH,
  createDefaultCanonicalConfig,
  loadCanonicalMcpConfig,
  renderServersForTarget,
  writeClientMcpConfigs,
  writeCopilotLaunchers
};
