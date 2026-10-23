'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');

// The first run of bullets under `## operating rules` in atris.md. Adapters
// (AGENTS.md, CLAUDE.md) carry a copy so tools that never open atris.md still
// see them; atris.md stays the one source.
function extractOpeningLines(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## operating rules\s*$/i.test(line));
  if (start === -1) return '';
  const bullets = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    if (line.startsWith('- ')) bullets.push(line);
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

module.exports = {
  extractOpeningLines,
  openingLinesForRoot,
  renderOpeningLinesBlock,
};
