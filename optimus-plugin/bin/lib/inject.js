/**
 * Shared system-instructions injection logic.
 * Used by both `optimus init` and `optimus upgrade` to ensure IDE instruction
 * files contain actionable Optimus guidance with version-aware replacement.
 */

const fs = require('fs');
const path = require('path');

const OPEN_RE = /<!-- optimus-instructions v(\d+) -->/;
const CLOSE_MARKER = '<!-- /optimus-instructions -->';

/**
 * Load instruction templates from scaffold/instructions/.
 * @returns {{ defaultTemplate: string, defaultVersion: number, cursorTemplate: string }}
 */
function loadTemplates() {
  const instrDir = path.resolve(__dirname, '..', '..', 'scaffold', 'instructions');
  const defaultTemplate = fs.readFileSync(path.join(instrDir, 'default.md'), 'utf8');
  const cursorTemplate = fs.readFileSync(path.join(instrDir, 'cursor.mdc'), 'utf8');

  const match = defaultTemplate.match(OPEN_RE);
  const defaultVersion = match ? parseInt(match[1], 10) : 1;

  return { defaultTemplate, defaultVersion, cursorTemplate };
}

/**
 * Apply version-aware block replacement to file content.
 * @param {string} content - Existing file content
 * @param {string} template - The template block to inject
 * @param {number} templateVersion - Version number from the template
 * @returns {{ content: string, action: 'replaced'|'injected'|'skipped', oldVersion?: number, warning?: string }}
 */
function applyVersionBlock(content, template, templateVersion) {
  const openMatch = content.match(OPEN_RE);

  if (!openMatch) {
    // No markers found — append template
    const trimmed = content.trimEnd();
    const newContent = trimmed.length > 0
      ? trimmed + '\n\n' + template.trimEnd() + '\n'
      : template.trimEnd() + '\n';
    return { content: newContent, action: 'injected' };
  }

  const existingVersion = parseInt(openMatch[1], 10);

  if (existingVersion >= templateVersion) {
    return { content, action: 'skipped' };
  }

  // Version is stale — replace the block
  const openIdx = content.indexOf(openMatch[0]);
  const closeIdx = content.indexOf(CLOSE_MARKER, openIdx);

  if (closeIdx === -1) {
    // Closing marker missing — skip and warn
    return {
      content,
      action: 'skipped',
      warning: 'Malformed block (missing closing marker) — skipped'
    };
  }

  const before = content.substring(0, openIdx);
  const after = content.substring(closeIdx + CLOSE_MARKER.length);
  const newContent = before + template.trimEnd() + after;

  return { content: newContent, action: 'replaced', oldVersion: existingVersion };
}

/**
 * Inject Optimus system-instructions into IDE instruction files.
 * Version-aware: replaces stale blocks, skips current ones, appends if missing.
 * @param {string} cwd - The project root directory
 * @returns {{ created: string[], injected: string[], replaced: Array<{path: string, from: number|null, to: number}>, skipped: string[], errors: string[] }}
 */
function injectSystemInstructions(cwd) {
  const created = [];
  const injected = [];
  const replaced = [];
  const skipped = [];
  const errors = [];

  // Validate cwd
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      errors.push('cwd is not a directory: ' + cwd);
      return { created, injected, replaced, skipped, errors };
    }
  } catch (e) {
    errors.push('cwd does not exist: ' + cwd);
    return { created, injected, replaced, skipped, errors };
  }

  if (!fs.existsSync(path.join(cwd, '.optimus'))) {
    errors.push('.optimus/ directory not found — has init been run?');
    return { created, injected, replaced, skipped, errors };
  }

  var templates;
  try {
    templates = loadTemplates();
  } catch (e) {
    errors.push('Failed to load instruction templates: ' + e.message);
    return { created, injected, replaced, skipped, errors };
  }

  var defaultTemplate = templates.defaultTemplate;
  var defaultVersion = templates.defaultVersion;
  var cursorTemplate = templates.cursorTemplate;

  /**
   * Process a markdown target (Claude/Copilot) using default.md template.
   * @param {string} relPath - Relative path from cwd
   * @param {boolean} createIfMissing - Whether to create the file if absent
   */
  function processMdTarget(relPath, createIfMissing) {
    var fullPath = path.join(cwd, relPath);
    try {
      if (fs.existsSync(fullPath)) {
        var existing = fs.readFileSync(fullPath, 'utf8');
        var result = applyVersionBlock(existing, defaultTemplate, defaultVersion);

        if (result.warning) {
          errors.push(relPath + ': ' + result.warning);
        }

        if (result.action === 'replaced') {
          fs.writeFileSync(fullPath, result.content, 'utf8');
          replaced.push({ path: relPath, from: result.oldVersion, to: defaultVersion });
        } else if (result.action === 'injected') {
          fs.writeFileSync(fullPath, result.content, 'utf8');
          injected.push(relPath);
        } else {
          skipped.push(relPath);
        }
      } else if (createIfMissing) {
        var dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, defaultTemplate.trimEnd() + '\n', 'utf8');
        created.push(relPath);
      }
    } catch (e) {
      errors.push(relPath + ': ' + e.message);
    }
  }

  /**
   * Process the Cursor MDC target — Optimus owns this file entirely.
   * @param {string} relPath - Relative path from cwd
   */
  function processCursorTarget(relPath) {
    var fullPath = path.join(cwd, relPath);
    try {
      var dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(fullPath)) {
        var existing = fs.readFileSync(fullPath, 'utf8');
        if (existing.trimEnd() === cursorTemplate.trimEnd()) {
          skipped.push(relPath);
        } else {
          fs.writeFileSync(fullPath, cursorTemplate.trimEnd() + '\n', 'utf8');
          replaced.push({ path: relPath, from: null, to: defaultVersion });
        }
      } else {
        fs.writeFileSync(fullPath, cursorTemplate.trimEnd() + '\n', 'utf8');
        created.push(relPath);
      }
    } catch (e) {
      errors.push(relPath + ': ' + e.message);
    }
  }

  // Claude Code: .claude/CLAUDE.md — create if missing
  processMdTarget('.claude/CLAUDE.md', true);

  // Root CLAUDE.md — append-only to existing, never create
  processMdTarget('CLAUDE.md', false);

  // GitHub Copilot — create if missing
  processMdTarget('.github/copilot-instructions.md', true);

  // Cursor — create if missing, full file replace (Optimus-owned)
  processCursorTarget('.cursor/rules/optimus.mdc');

  return { created, injected, replaced, skipped, errors };
}

module.exports = { injectSystemInstructions };
