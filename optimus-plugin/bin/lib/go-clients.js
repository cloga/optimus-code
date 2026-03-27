const path = require('path');
const fs = require('fs');

const CLIENT_ADAPTERS = {
  copilot: {
    id: 'copilot',
    executable: 'copilot',
    label: 'GitHub Copilot CLI',
    resolveConfigPath(projectPath) {
      const config = path.join(projectPath, '.copilot', 'mcp-config.json');
      return fs.existsSync(config) ? config : undefined;
    },
    buildArgs(configPath, passthroughArgs) {
      const args = [];
      if (configPath) {
        args.push('--additional-mcp-config', `@${configPath}`);
      }
      return args.concat(passthroughArgs);
    }
  },
  claude: {
    id: 'claude',
    executable: 'claude',
    label: 'Claude Code CLI',
    resolveConfigPath(projectPath) {
      const config = path.join(projectPath, '.mcp.json');
      return fs.existsSync(config) ? config : undefined;
    },
    buildArgs(configPath, passthroughArgs) {
      const args = [];
      if (configPath) {
        args.push('--mcp-config', configPath);
      }
      return args.concat(passthroughArgs);
    }
  }
};

const DEFAULT_CLIENT = 'copilot';

function getClientAdapter(clientId) {
  const adapter = CLIENT_ADAPTERS[clientId];
  if (!adapter) {
    const available = Object.keys(CLIENT_ADAPTERS).join(', ');
    throw new Error(`Unknown CLI client '${clientId}'. Available clients: ${available}`);
  }
  return adapter;
}

function resolveCliClient(cliOverride, project, registryDefaults) {
  if (cliOverride) return cliOverride;
  if (project?.preferredCli) return project.preferredCli;
  if (registryDefaults?.cli) return registryDefaults.cli;
  return DEFAULT_CLIENT;
}

function listAvailableClients() {
  return Object.values(CLIENT_ADAPTERS).map(adapter => ({
    id: adapter.id,
    label: adapter.label,
    executable: adapter.executable
  }));
}

module.exports = {
  CLIENT_ADAPTERS,
  DEFAULT_CLIENT,
  getClientAdapter,
  listAvailableClients,
  resolveCliClient
};
