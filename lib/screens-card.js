'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureAlwaysApplyFrontmatter } = require('./voice-card');

const PACKAGE_ROOT = path.join(__dirname, '..');
const SCREENS_START = '<!-- ATRIS_SCREENS:START -->';
const SCREENS_END = '<!-- ATRIS_SCREENS:END -->';

// Files a coding tool reads before its first reply. Each one that exists gets
// the block. Cursor gets its own always-applied rule, made if missing, the
// same way the voice card gets one.
const ADAPTER_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules'];
const CURSOR_RULE = path.join('.cursor', 'rules', 'atris-screens.mdc');

// The bullets under `## screens` in atris.md: the rules for any page a person
// will look at. An older atris.md has no such section and yields nothing.
function extractScreensRules(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## screens\s*$/i.test(line));
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

function readScreensRules(root) {
  for (const file of [path.join(root, 'atris.md'), path.join(root, 'atris', 'atris.md')]) {
    if (!fs.existsSync(file)) continue;
    const found = extractScreensRules(fs.readFileSync(file, 'utf8'));
    if (found) return found;
  }
  return '';
}

// init writes the adapters before it copies atris.md, so a new project reads
// the package copy.
function screensRulesForRoot(root = process.cwd()) {
  return readScreensRules(root) || readScreensRules(PACKAGE_ROOT);
}

function renderScreensBlock(bullets) {
  if (!bullets) return '';
  return `${SCREENS_START}\n## Screens\n\n${bullets}\n${SCREENS_END}`;
}

// Replace a marked copy in place. Otherwise put it right before `## You
// translate` (the atris-written AGENTS.md layout), before the brain compile
// block, or at the end.
function placeScreensBlock(source, block) {
  const start = source.indexOf(SCREENS_START);
  const end = source.indexOf(SCREENS_END, start + SCREENS_START.length);
  if (start !== -1 && end !== -1) {
    return `${source.slice(0, start)}${block}${source.slice(end + SCREENS_END.length)}`;
  }
  const anchor = ['\n## You translate', '\n<!-- ATRIS_BRAIN_COMPILE:START -->']
    .map((marker) => source.indexOf(marker))
    .find((index) => index !== -1);
  if (anchor !== undefined) {
    return `${source.slice(0, anchor).trimEnd()}\n\n${block}\n${source.slice(anchor)}`;
  }
  const separator = source.trim() ? '\n\n' : '';
  return `${source.trimEnd()}${separator}${block}\n`;
}

// Returns the files that changed, relative to root.
function upsertScreensAdapters(root, bullets, options = {}) {
  const block = renderScreensBlock(bullets);
  if (!block) return [];
  const changed = [];
  const write = (rel, source, content) => {
    if (content === source) return;
    if (!options.dryRun) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    }
    changed.push(rel);
  };
  for (const rel of ADAPTER_FILES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    write(rel, source, placeScreensBlock(source, block));
  }
  const cursorFile = path.join(root, CURSOR_RULE);
  const cursorSource = fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, 'utf8') : '';
  write(CURSOR_RULE, cursorSource, placeScreensBlock(ensureAlwaysApplyFrontmatter(cursorSource), block));
  return changed;
}

module.exports = {
  extractScreensRules,
  renderScreensBlock,
  screensRulesForRoot,
  upsertScreensAdapters,
};
