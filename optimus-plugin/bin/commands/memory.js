#!/usr/bin/env node

/**
 * `optimus memory` — Manage user-level cross-project memory.
 *
 * Subcommands:
 *   (none)   Print full user memory to stdout
 *   init     Create template at ~/.optimus/memory/user-memory.md
 *   list     Print numbered entries
 *   edit     Open in $EDITOR / code / notepad
 *   add      Add an entry (optionally with --category)
 *   remove   Remove entry by number
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn: spawnChild } = require('child_process');

const ALLOWED_CATEGORIES = ['preferences', 'toolchain', 'lessons', 'team conventions', 'uncategorized'];

function getMemoryPath() {
    return process.env.OPTIMUS_USER_MEMORY_PATH ||
        path.join(os.homedir(), '.optimus', 'memory', 'user-memory.md');
}

function parseEntries(content) {
    const entries = [];
    const lines = content.split('\n');
    let currentSection = 'Uncategorized';

    for (let i = 0; i < lines.length; i++) {
        const sectionMatch = lines[i].match(/^##\s+(.+)/);
        if (sectionMatch) {
            currentSection = sectionMatch[1].trim();
            continue;
        }
        const entryMatch = lines[i].match(/^-\s+(.+)/);
        if (entryMatch) {
            entries.push({
                section: currentSection,
                text: entryMatch[1].trim(),
                lineNumber: i + 1,
            });
        }
    }
    return entries;
}

function updateHeader(content) {
    const lines = content.split('\n');
    const entryCount = parseEntries(content).length;

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
        if (lines[i].startsWith('# Last updated:')) {
            lines[i] = `# Last updated: ${new Date().toISOString()}`;
        }
        if (lines[i].startsWith('# Entries:')) {
            lines[i] = `# Entries: ${entryCount}`;
        }
    }
    return lines.join('\n');
}

function resolveCategory(category) {
    const lower = category.toLowerCase();
    const match = ALLOWED_CATEGORIES.find(c => c === lower);
    if (!match) return 'Uncategorized';
    // Capitalize first letter of each word
    return match.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

module.exports = function memory() {
    const subcommand = process.argv[3];
    const memPath = getMemoryPath();

    // --- No subcommand: print file ---
    if (!subcommand) {
        if (!fs.existsSync(memPath)) {
            console.log('No user memory found. Run `optimus memory init` to create one.');
            return;
        }
        console.log(fs.readFileSync(memPath, 'utf8'));
        return;
    }

    // --- init ---
    if (subcommand === 'init') {
        if (fs.existsSync(memPath)) {
            console.error(`User memory already exists at ${memPath}`);
            console.error('Use `optimus memory edit` to modify it, or delete the file to re-initialize.');
            process.exit(1);
        }
        const dir = path.dirname(memPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const template = `# User Memory — managed by Optimus
# Last updated: ${new Date().toISOString()}
# Entries: 0

## Preferences

## Toolchain

## Lessons

## Team Conventions
`;
        fs.writeFileSync(memPath, template, 'utf8');
        console.log(`✅ User memory initialized at ${memPath}`);
        console.log('Edit with `optimus memory edit` or add entries with `optimus memory add "text"`');
        return;
    }

    // --- list ---
    if (subcommand === 'list') {
        if (!fs.existsSync(memPath)) {
            console.log('No user memory found. Run `optimus memory init` first.');
            return;
        }
        const content = fs.readFileSync(memPath, 'utf8');
        const entries = parseEntries(content);
        if (entries.length === 0) {
            console.log('No entries in user memory. Add one with `optimus memory add "text"`');
            return;
        }
        let currentSection = '';
        entries.forEach((entry, idx) => {
            if (entry.section !== currentSection) {
                currentSection = entry.section;
                console.log(`\n## ${currentSection}`);
            }
            console.log(`  ${idx + 1}. ${entry.text}`);
        });
        console.log('');
        return;
    }

    // --- edit ---
    if (subcommand === 'edit') {
        if (!fs.existsSync(memPath)) {
            console.log('No user memory found. Run `optimus memory init` first.');
            return;
        }

        // Detect editor
        let editor = process.env.EDITOR;
        if (!editor) {
            // Try to detect common editors
            try {
                execSync('code --version', { stdio: 'ignore' });
                editor = 'code --wait';
            } catch {
                if (process.platform === 'win32') {
                    editor = 'notepad';
                } else {
                    editor = 'nano';
                }
            }
        }

        console.log(`Opening user memory in ${editor.split(' ')[0]}...`);
        const parts = editor.split(/\s+/);
        const cmd = parts[0];
        const args = [...parts.slice(1), memPath];

        try {
            const child = spawnChild(cmd, args, { stdio: 'inherit', shell: true });
            child.on('error', (err) => {
                console.error(`Failed to open editor: ${err.message}`);
                console.error(`Set $EDITOR to your preferred editor, or edit manually: ${memPath}`);
            });
        } catch (err) {
            console.error(`Failed to open editor: ${err.message}`);
            console.error(`Edit manually: ${memPath}`);
        }
        return;
    }

    // --- add ---
    if (subcommand === 'add') {
        if (!fs.existsSync(memPath)) {
            console.log('No user memory found. Run `optimus memory init` first.');
            process.exit(1);
        }

        // Parse --category flag
        let category = 'uncategorized';
        let textArgs = process.argv.slice(4);

        const categoryIdx = textArgs.indexOf('--category');
        if (categoryIdx !== -1 && categoryIdx + 1 < textArgs.length) {
            category = textArgs[categoryIdx + 1];
            textArgs.splice(categoryIdx, 2);
        }

        const text = textArgs.join(' ').trim();
        if (!text) {
            console.error('Usage: optimus memory add [--category <category>] "text"');
            process.exit(1);
        }

        const resolvedCategory = resolveCategory(category);
        const sectionHeader = `## ${resolvedCategory}`;

        let content = fs.readFileSync(memPath, 'utf8');
        const lines = content.split('\n');
        let sectionIdx = -1;
        let nextSectionIdx = -1;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().toLowerCase() === sectionHeader.toLowerCase()) {
                sectionIdx = i;
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].match(/^##\s+/)) {
                        nextSectionIdx = j;
                        break;
                    }
                }
                break;
            }
        }

        if (sectionIdx === -1) {
            // Find last section and insert before it
            let lastSectionIdx = -1;
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].match(/^##\s+/)) {
                    lastSectionIdx = i;
                    break;
                }
            }
            if (lastSectionIdx >= 0) {
                lines.splice(lastSectionIdx, 0, sectionHeader, `- ${text}`, '');
            } else {
                lines.push('', sectionHeader, `- ${text}`, '');
            }
        } else {
            const insertIdx = nextSectionIdx !== -1 ? nextSectionIdx : lines.length;
            lines.splice(insertIdx, 0, `- ${text}`);
        }

        const newContent = updateHeader(lines.join('\n'));

        // Atomic write
        const tmpPath = memPath + '.tmp';
        fs.writeFileSync(tmpPath, newContent, 'utf8');
        fs.renameSync(tmpPath, memPath);

        console.log(`✅ Added to ## ${resolvedCategory}: ${text}`);
        return;
    }

    // --- remove ---
    if (subcommand === 'remove') {
        if (!fs.existsSync(memPath)) {
            console.log('No user memory found. Run `optimus memory init` first.');
            process.exit(1);
        }

        const indexStr = process.argv[4];
        const index = parseInt(indexStr, 10);
        if (isNaN(index) || index < 1) {
            console.error('Usage: optimus memory remove <number>');
            console.error('Use `optimus memory list` to see entry numbers.');
            process.exit(1);
        }

        const content = fs.readFileSync(memPath, 'utf8');
        const entries = parseEntries(content);

        if (index > entries.length) {
            console.error(`Invalid entry number ${index}. Only ${entries.length} entries exist.`);
            process.exit(1);
        }

        const target = entries[index - 1];
        const lines = content.split('\n');
        lines.splice(target.lineNumber - 1, 1);

        const newContent = updateHeader(lines.join('\n'));

        // Atomic write
        const tmpPath = memPath + '.tmp';
        fs.writeFileSync(tmpPath, newContent, 'utf8');
        fs.renameSync(tmpPath, memPath);

        console.log(`✅ Removed entry #${index} from ## ${target.section}: ${target.text}`);
        return;
    }

    // Unknown subcommand
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Usage: optimus memory [init|list|edit|add|remove]');
    process.exit(1);
};
