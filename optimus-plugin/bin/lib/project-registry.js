const fs = require('fs');
const os = require('os');
const path = require('path');

function getProjectsRegistryPath() {
  return process.env.OPTIMUS_PROJECTS_REGISTRY_PATH ||
    path.join(os.homedir(), '.optimus', 'projects.json');
}

function createEmptyRegistry() {
  return {
    version: 1,
    projects: []
  };
}

function normalizeProjectPath(projectPath) {
  return path.resolve(projectPath);
}

function normalizeAliases(aliases) {
  if (!Array.isArray(aliases)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const alias of aliases) {
    if (typeof alias !== 'string') {
      continue;
    }

    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeProjectEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
    return null;
  }

  const normalizedPath = normalizeProjectPath(entry.path);
  const name = typeof entry.name === 'string' && entry.name.trim()
    ? entry.name.trim()
    : path.basename(normalizedPath);

  return {
    name,
    path: normalizedPath,
    aliases: normalizeAliases(entry.aliases),
    lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : undefined
  };
}

function loadProjectRegistry() {
  const registryPath = getProjectsRegistryPath();
  if (!fs.existsSync(registryPath)) {
    return createEmptyRegistry();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const projects = Array.isArray(raw?.projects)
      ? raw.projects.map(normalizeProjectEntry).filter(Boolean)
      : [];

    return {
      version: typeof raw?.version === 'number' ? raw.version : 1,
      projects
    };
  } catch {
    return createEmptyRegistry();
  }
}

function saveProjectRegistry(registry) {
  const registryPath = getProjectsRegistryPath();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });

  const normalizedRegistry = {
    version: 1,
    projects: Array.isArray(registry?.projects)
      ? registry.projects.map(normalizeProjectEntry).filter(Boolean)
      : []
  };

  const tempPath = `${registryPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(normalizedRegistry, null, 2) + '\n', 'utf8');
  fs.renameSync(tempPath, registryPath);

  return normalizedRegistry;
}

function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    const aTime = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
    const bTime = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
    if (aTime !== bTime) {
      return bTime - aTime;
    }

    return a.name.localeCompare(b.name);
  });
}

function registerProject(workspacePath, options = {}) {
  const registry = loadProjectRegistry();
  const normalizedPath = normalizeProjectPath(workspacePath);
  const defaultName = path.basename(normalizedPath);
  const existing = registry.projects.find(project => project.path.toLowerCase() === normalizedPath.toLowerCase());
  const name = typeof options.name === 'string' && options.name.trim()
    ? options.name.trim()
    : existing?.name || defaultName;
  const aliases = normalizeAliases([
    ...(existing?.aliases || []),
    ...(options.aliases || [])
  ]);

  const nextEntry = {
    name,
    path: normalizedPath,
    aliases,
    lastUsedAt: existing?.lastUsedAt
  };

  registry.projects = registry.projects
    .filter(project => project.path.toLowerCase() !== normalizedPath.toLowerCase())
    .concat(nextEntry);

  saveProjectRegistry(registry);
  return nextEntry;
}

function touchProject(workspacePath) {
  const registry = loadProjectRegistry();
  const normalizedPath = normalizeProjectPath(workspacePath);
  const now = new Date().toISOString();
  let updatedProject;

  registry.projects = registry.projects.map(project => {
    if (project.path.toLowerCase() !== normalizedPath.toLowerCase()) {
      return project;
    }

    updatedProject = {
      ...project,
      lastUsedAt: now
    };
    return updatedProject;
  });

  if (!updatedProject) {
    updatedProject = {
      ...registerProject(normalizedPath),
      lastUsedAt: now
    };

    const refreshed = loadProjectRegistry();
    refreshed.projects = refreshed.projects.map(project =>
      project.path.toLowerCase() === normalizedPath.toLowerCase()
        ? updatedProject
        : project
    );
    saveProjectRegistry(refreshed);
    return updatedProject;
  }

  saveProjectRegistry(registry);
  return updatedProject;
}

function findProjectsByIdentifier(identifier, projects) {
  const needle = identifier.trim().toLowerCase();
  const exactName = projects.find(project => project.name.toLowerCase() === needle);
  if (exactName) {
    return [exactName];
  }

  const exactAlias = projects.find(project => project.aliases.some(alias => alias.toLowerCase() === needle));
  if (exactAlias) {
    return [exactAlias];
  }

  return projects.filter(project =>
    project.name.toLowerCase().includes(needle) ||
    project.aliases.some(alias => alias.toLowerCase().includes(needle))
  );
}

function scanForProjects(scanRoot = os.homedir()) {
  const normalizedRoot = normalizeProjectPath(scanRoot);
  const candidates = [normalizedRoot];
  const discovered = [];

  if (fs.existsSync(normalizedRoot)) {
    for (const entry of fs.readdirSync(normalizedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      candidates.push(path.join(normalizedRoot, entry.name));
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeProjectPath(candidate);
    if (seen.has(normalizedCandidate.toLowerCase())) {
      continue;
    }
    seen.add(normalizedCandidate.toLowerCase());

    if (fs.existsSync(path.join(normalizedCandidate, '.optimus'))) {
      discovered.push(registerProject(normalizedCandidate));
    }
  }

  return sortProjects(discovered);
}

module.exports = {
  createEmptyRegistry,
  findProjectsByIdentifier,
  getProjectsRegistryPath,
  loadProjectRegistry,
  normalizeAliases,
  normalizeProjectPath,
  registerProject,
  saveProjectRegistry,
  scanForProjects,
  sortProjects,
  touchProject
};
