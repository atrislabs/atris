'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');

// The values in atris.md, each as its name and its first sentence, so the
// boot can show them in every new chat instead of leaving them deep in a long
// file. A workspace that writes its own under a `## values` heading gets
// those, whatever they are called. Otherwise the four that open the operating
// rules (acceleration, accuracy, ambition, agency) are found by name. A
// workspace with neither gets the package copy.
const VALUE_NAMES = ['acceleration', 'accuracy', 'ambition', 'agency'];
const BULLET = /^- \*\*([^*]+?)\.\*\*\s+([^.]+)\./;
const asValue = (match) => ({ name: match[1].toLowerCase(), gist: match[2][0].toLowerCase() + match[2].slice(1) });

function extractValues(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## values\s*$/i.test(line));
  if (start !== -1) {
    const values = [];
    for (let index = start + 1; index < lines.length && !/^##\s+/.test(lines[index]); index += 1) {
      const match = lines[index].match(BULLET);
      if (match) values.push(asValue(match));
    }
    if (values.length) return values;
  }
  const found = new Map();
  for (const line of lines) {
    const match = line.match(BULLET);
    if (!match) continue;
    const value = asValue(match);
    if (VALUE_NAMES.includes(value.name) && !found.has(value.name)) found.set(value.name, value);
  }
  return found.size === VALUE_NAMES.length ? VALUE_NAMES.map((name) => found.get(name)) : [];
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
