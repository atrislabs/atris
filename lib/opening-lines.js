'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');

const AGENTS_START = '<!-- ATRIS_OPERATING_RULES:START -->';
const AGENTS_END = '<!-- ATRIS_OPERATING_RULES:END -->';

// The first run of bold-lead bullets (`- **Word.** ...`) under
// `## operating rules` in atris.md. Adapters (AGENTS.md, CLAUDE.md) carry a
// copy so tools that never open atris.md still see them; atris.md stays the
// one source. An older atris.md has only plain checklist bullets there, so it
// yields nothing and the caller falls back to the package copy.
function extractOpeningLines(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## operating rules\s*$/i.test(line));
  if (start === -1) return '';
  const bullets = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    if (/^- \*\*[^*]+\.\*\* /.test(line)) bullets.push(line);
    else if (bullets.length && line.trim()) break;
  }
  return bullets.join('\n');
}

function readOpeningLines(root) {
  for (const file of [path.join(root, 'atris.md'), path.join(root, 'atris', 'atris.md')]) {
    if (!fs.existsSync(file)) continue;
    const found = extractOpeningLines(fs.readFileSync(file, 'utf8'));
    if (found) return found;
  }
  return '';
}

function openingLinesForRoot(root = process.cwd()) {
  return readOpeningLines(root) || readOpeningLines(PACKAGE_ROOT);
}

function renderOpeningLinesBlock(bullets, adapter) {
  if (!bullets) return '';
  return `## Operating rules

${bullets}

Canonical source: \`atris/atris.md\` \`## operating rules\`. This is a copy for tools that only read \`${adapter}\`; if they differ, atris.md wins.`;
}

function renderAgentsOpeningBlock(bullets) {
  const block = renderOpeningLinesBlock(bullets, 'AGENTS.md');
  return block ? `${AGENTS_START}\n${block}\n${AGENTS_END}` : '';
}

// Existing AGENTS.md files predate the copy. Replace a marked copy in place;
// otherwise put it right before `## You translate` (the atris-written layout),
// before the brain compile block, or at the end.
function upsertAgentsOpeningLines(filePath, bullets, options = {}) {
  const block = renderAgentsOpeningBlock(bullets);
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (!block) return { action: 'unchanged', content: source };
  let content;
  const start = source.indexOf(AGENTS_START);
  const end = source.indexOf(AGENTS_END, start + AGENTS_START.length);
  if (start !== -1 && end !== -1) {
    content = `${source.slice(0, start)}${block}${source.slice(end + AGENTS_END.length)}`;
  } else {
    const anchor = ['\n## You translate', '\n<!-- ATRIS_BRAIN_COMPILE:START -->']
      .map((marker) => source.indexOf(marker))
      .find((index) => index !== -1);
    if (anchor !== undefined) {
      content = `${source.slice(0, anchor).trimEnd()}\n\n${block}\n${source.slice(anchor)}`;
    } else {
      const prefix = source.trimEnd() || '# AGENTS';
      content = `${prefix}\n\n${block}\n`;
    }
  }
  const changed = content !== source;
  if (changed && !options.dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { action: source ? (changed ? 'updated' : 'unchanged') : 'created', content };
}

module.exports = {
  extractOpeningLines,
  openingLinesForRoot,
  renderAgentsOpeningBlock,
  renderOpeningLinesBlock,
  upsertAgentsOpeningLines,
};
