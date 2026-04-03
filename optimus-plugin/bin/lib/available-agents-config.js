const fs = require('fs');
const os = require('os');
const path = require('path');

function getUserAvailableAgentsConfigPath() {
  return process.env.OPTIMUS_USER_AVAILABLE_AGENTS_PATH || path.join(os.homedir(), '.optimus', 'config', 'available-agents.json');
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyFileIfMissing(srcPath, destPath) {
  ensureParentDir(destPath);
  if (fs.existsSync(destPath)) {
    return false;
  }
  fs.copyFileSync(srcPath, destPath);
  return true;
}

function copyFileForce(srcPath, destPath) {
  ensureParentDir(destPath);
  fs.copyFileSync(srcPath, destPath);
}

function getDisabledProjectAvailableAgentsPath(projectConfigDir, index = 0) {
  const suffix = index === 0 ? '' : `.${index}`;
  return path.join(projectConfigDir, `available-agents.project.disabled${suffix}.json`);
}

function disableProjectAvailableAgentsOverride(projectConfigDir) {
  const activePath = path.join(projectConfigDir, 'available-agents.json');
  if (!fs.existsSync(activePath)) {
    return null;
  }

  ensureParentDir(activePath);

  let disabledPath = getDisabledProjectAvailableAgentsPath(projectConfigDir);
  let index = 1;
  while (fs.existsSync(disabledPath)) {
    disabledPath = getDisabledProjectAvailableAgentsPath(projectConfigDir, index);
    index += 1;
  }

  fs.renameSync(activePath, disabledPath);
  return {
    activePath,
    disabledPath,
  };
}

function deepMergePreserveUser(template, user) {
  const result = { ...template };
  for (const key of Object.keys(user)) {
    if (typeof user[key] === 'object' && user[key] !== null && !Array.isArray(user[key])
        && typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = deepMergePreserveUser(result[key], user[key]);
    } else {
      result[key] = user[key];
    }
  }
  return result;
}

function patchAvailableAgentsConfig(agents, template) {
  let patched = false;
  for (const engineName of Object.keys(template.engines || {})) {
    const templateEngine = template.engines[engineName];
    const userEngine = agents.engines?.[engineName];
    if (!userEngine) continue;

    for (const transport of ['acp', 'cli']) {
      const templateCaps = templateEngine[transport]?.capabilities;
      const userCaps = userEngine[transport]?.capabilities;
      if (!templateCaps || !userCaps) continue;

      for (const capKey of ['automation_modes', 'automation_continuations']) {
        const templateArray = templateCaps[capKey];
        const userArray = userCaps[capKey];
        if (!Array.isArray(templateArray)) continue;

        if (!Array.isArray(userArray)) {
          userCaps[capKey] = [...templateArray];
          patched = true;
        } else {
          const merged = [...new Set([...userArray, ...templateArray])];
          if (merged.length !== userArray.length) {
            userCaps[capKey] = merged;
            patched = true;
          }
        }
      }
    }

    if (templateEngine.protocol === 'auto' && userEngine.protocol !== 'auto'
        && userEngine.acp && userEngine.cli) {
      userEngine.protocol = 'auto';
      if (templateEngine.preferred_protocol && !userEngine.preferred_protocol) {
        userEngine.preferred_protocol = templateEngine.preferred_protocol;
      }
      patched = true;
    }

    if (userEngine.acp?.args && Array.isArray(userEngine.acp.args)) {
      const filtered = userEngine.acp.args.filter(arg => arg !== '--stdio');
      if (filtered.length !== userEngine.acp.args.length) {
        userEngine.acp.args = filtered;
        patched = true;
      }
    }

    if (!templateEngine.acp && userEngine.acp && isRedundantDefaultAcpConfig(engineName, userEngine.acp)) {
      delete userEngine.acp;
      patched = true;
    }
  }

  return patched;
}

function isRedundantDefaultAcpConfig(engineName, acpConfig) {
  if (!acpConfig || typeof acpConfig !== 'object') {
    return false;
  }

  const pathValue = typeof acpConfig.path === 'string' ? acpConfig.path.trim() : '';
  const args = Array.isArray(acpConfig.args)
    ? acpConfig.args.filter(arg => typeof arg === 'string' && arg.trim().length > 0)
    : [];
  const hasCapabilities = !!acpConfig.capabilities;
  const otherKeys = Object.keys(acpConfig).filter(key => !['path', 'args', 'capabilities'].includes(key));
  if (hasCapabilities || otherKeys.length > 0) {
    return false;
  }

  if (engineName === 'claude-code') {
    return pathValue === 'claude-agent-acp' && args.length === 0;
  }

  if (engineName === 'github-copilot') {
    const normalizedArgs = args.join(' ');
    return pathValue === 'copilot'
      && (normalizedArgs === '' || normalizedArgs === '--acp' || normalizedArgs === '--acp --stdio');
  }

  return false;
}

function syncAvailableAgentsConfig(templatePath, destPath) {
  ensureParentDir(destPath);
  if (!fs.existsSync(destPath)) {
    fs.copyFileSync(templatePath, destPath);
    return { created: true, overwrittenDueToError: false, preservedUserValues: false, patched: false };
  }

  try {
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const user = JSON.parse(fs.readFileSync(destPath, 'utf8'));
    const merged = deepMergePreserveUser(template, user);
    const preservedUserValues = JSON.stringify(merged) !== JSON.stringify(template);
    const patched = patchAvailableAgentsConfig(merged, template);
    fs.writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf8');
    return { created: false, overwrittenDueToError: false, preservedUserValues, patched };
  } catch (error) {
    fs.copyFileSync(templatePath, destPath);
    return { created: false, overwrittenDueToError: true, preservedUserValues: false, patched: false };
  }
}

module.exports = {
  copyFileForce,
  copyFileIfMissing,
  disableProjectAvailableAgentsOverride,
  deepMergePreserveUser,
  getUserAvailableAgentsConfigPath,
  patchAvailableAgentsConfig,
  syncAvailableAgentsConfig,
};
