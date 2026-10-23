'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');

// The bold-lead bullets under `## values` in atris.md, each as its name and
// its first sentence, so the boot can show them in every new chat instead of
// leaving them deep in a long file. A workspace made before the values
// shipped has no such section; the package copy stands in for it.
function extractValues(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## values\s*$/i.test(line));
  if (start === -1) return [];
  const values = [];
  for (let index = start + 1; index < lines.length && !/^##\s+/.test(lines[index]); index += 1) {
    const match = lines[index].match(/^- \*\*([^*]+?)\.\*\*\s+([^.]+)\./);
    if (match) values.push({ name: match[1].toLowerCase(), gist: match[2][0].toLowerCase() + match[2].slice(1) });
  }
  return values;
}

function readValues(root) {
  for (const file of [path.join(root, 'atris.md'), path.join(root, 'atris', 'atris.md')]) {
    if (!fs.existsSync(file)) continue;
    const found = extractValues(fs.readFileSync(file, 'utf8'));
    if (found.length) return found;
  }
  return [];
}

function valuesForRoot(root = process.cwd()) {
  const own = readValues(root);
  return own.length ? own : readValues(PACKAGE_ROOT);
}

module.exports = { extractValues, valuesForRoot };
