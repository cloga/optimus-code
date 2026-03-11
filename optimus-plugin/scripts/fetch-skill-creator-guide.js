/**
 * fetch-skill-creator-guide.js
 *
 * Pre-build script that fetches the official Claude skill-creator plugin page
 * and saves a reference guide to optimus-plugin/skills/skill-checker/official-guide.md.
 *
 * If the fetch fails (network error, 403, etc.), the build continues — the
 * existing file (if any) is left untouched.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://claude.com/plugins/skill-creator';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'skills', 'skill-checker', 'official-guide.md');

/**
 * Minimal HTML-to-text extraction.
 * Strips tags, decodes common entities, and collapses whitespace.
 */
function htmlToText(html) {
  // Remove script/style blocks
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Convert <br> and block-level closers to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse runs of whitespace (preserve newlines)
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Extract only the plugin description section from the full page text.
 * The page has navigation/footer noise — we want the content between
 * "Skill Creator" heading and "Related plugins".
 */
function extractPluginContent(fullText) {
  // Find the main content block: starts after "Skill Creator\nCreate, improve"
  const startMatch = fullText.match(/Skill Creator\nCreate, improve/);
  if (!startMatch) return null;

  const startIdx = startMatch.index;

  // End at "Related plugins" or "Homepage" footer markers
  const endMarkers = ['Related plugins', 'HomepageHomepage'];
  let endIdx = fullText.length;
  for (const marker of endMarkers) {
    const idx = fullText.indexOf(marker, startIdx);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  }

  return fullText.substring(startIdx, endIdx).trim();
}

async function fetchGuide() {
  const fetchDate = new Date().toISOString().split('T')[0];

  console.log(`[fetch-skill-creator-guide] Fetching ${SOURCE_URL} ...`);

  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'optimus-build/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const fullText = htmlToText(html);
  const body = extractPluginContent(fullText);

  if (!body || body.length < 100) {
    throw new Error('Extracted content too short — page may have changed structure');
  }

  const markdown = [
    '# Official Claude Skill Creator Guide',
    '',
    `> Auto-fetched from ${SOURCE_URL} on ${fetchDate}.`,
    '> This file is regenerated on each build. Do not edit manually.',
    '',
    body,
    '',
  ].join('\n');

  // Ensure the output directory exists
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_PATH, markdown, 'utf8');
  console.log(`[fetch-skill-creator-guide] Saved to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

module.exports = fetchGuide;

// Allow direct invocation: node scripts/fetch-skill-creator-guide.js
if (require.main === module) {
  fetchGuide().catch((e) => {
    console.warn(`[fetch-skill-creator-guide] Warning: ${e.message}`);
    process.exit(0); // non-fatal
  });
}
