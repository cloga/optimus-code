/**
 * Shared system-instructions injection logic.
 * Used by both `optimus init` and `optimus upgrade` to ensure IDE instruction
 * files reference `.optimus/config/system-instructions.md`.
 */

const fs = require('fs');
const path = require('path');

const injectMarker = '<!-- optimus-instructions -->';
const injectBlock = [
  injectMarker,
  '<!-- Auto-injected by optimus init — DO NOT EDIT this block -->',
  '## Optimus Swarm Instructions',
  '',
  'This project uses the [Optimus Spartan Swarm](https://github.com/cloga/optimus-code) multi-agent orchestrator.',
  'System instructions are maintained in `.optimus/config/system-instructions.md` and served via MCP Resource `optimus://system/instructions`.',
  '',
  'Please read and follow `.optimus/config/system-instructions.md` for all workflow protocols.',
  '<!-- /optimus-instructions -->',
].join('\n');

/**
 * Inject Optimus system-instructions reference into IDE instruction files.
 * Creates files if they don't exist. Idempotent via marker check.
 * @param {string} cwd - The project root directory
 * @returns {{ created: string[], injected: string[], skipped: string[] }}
 */
function injectSystemInstructions(cwd) {
  const created = [];
  const injected = [];
  const skipped = [];

  /**
   * Process a single target file.
   * @param {string} relPath - Relative path from cwd (e.g. '.claude/CLAUDE.md')
   * @param {boolean} createIfMissing - Whether to create the file if it doesn't exist
   */
  function processTarget(relPath, createIfMissing) {
    const fullPath = path.join(cwd, relPath);
    if (fs.existsSync(fullPath)) {
      const existing = fs.readFileSync(fullPath, 'utf8');
      if (existing.includes(injectMarker)) {
        skipped.push(relPath);
      } else {
        fs.appendFileSync(fullPath, '\n\n' + injectBlock + '\n');
        injected.push(relPath);
      }
    } else if (createIfMissing) {
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, injectBlock + '\n', 'utf8');
      created.push(relPath);
    }
  }

  // Claude Code (sequential):
  // 1. .claude/CLAUDE.md — create if missing
  processTarget('.claude/CLAUDE.md', true);
  // 2. Root CLAUDE.md — NEVER create, only inject if it already exists
  processTarget('CLAUDE.md', false);

  // GitHub Copilot — create if missing
  processTarget('.github/copilot-instructions.md', true);

  // Cursor — create if missing
  processTarget('.cursor/rules/optimus.mdc', true);

  return { created, injected, skipped };
}

module.exports = { injectSystemInstructions };
