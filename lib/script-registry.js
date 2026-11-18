'use strict';

// Scripts are data. Each file in lib/scripts/ is one guided zero to one run
// (questions, chapters, team seats). A second script is a new file here, never
// new command code. A file marked "ready": false stays hidden from the list.

const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname, 'scripts');

function isScript(value) {
  return Boolean(value)
    && typeof value.id === 'string' && /^[a-z0-9-]+$/.test(value.id)
    && typeof value.title === 'string'
    && Array.isArray(value.questions) && value.questions.length > 0
    && Array.isArray(value.chapters) && value.chapters.length > 0
    && value.chapters.every((chapter) => Array.isArray(chapter.moves) && chapter.moves.length > 0
      && chapter.moves.some((move) => move.finish));
}

function loadScripts(dir = SCRIPTS_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const scripts = [];
  for (const name of names) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!isScript(parsed) || parsed.ready === false) continue;
    scripts.push(parsed);
  }
  return scripts.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { SCRIPTS_DIR, loadScripts };
