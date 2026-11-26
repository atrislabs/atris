'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');

// Two atris.md sections are copied into the files a coding tool reads first,
// so tools that never open atris.md still see them; atris.md stays the one
// source. Each section names its heading, which bullets count and its markers.
const SECTIONS = {
  // the first run of bold-lead bullets (`- **Word.** ...`). An older atris.md
  // has only plain checklist bullets there, so it yields nothing.
  opening: { heading: 'operating rules', bullet: /^- \*\*[^*]+\.\*\* /, start: '<!-- ATRIS_OPERATING_RULES:START -->', end: '<!-- ATRIS_OPERATING_RULES:END -->' },
  // the rules for any page a person will look at. An older atris.md has no such section.
  screens: { heading: 'screens', bullet: /^- /, start: '<!-- ATRIS_SCREENS:START -->', end: '<!-- ATRIS_SCREENS:END -->' },
};
const AGENTS_START = SECTIONS.opening.start;
const AGENTS_END = SECTIONS.opening.end;
// Files a coding tool reads before its first reply. Each one that exists gets the screens block.
const SCREENS_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules'];

function extractSection(content, { heading, bullet }) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd().toLowerCase() === `## ${heading}`);
  if (start === -1) return '';
  const bullets = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    if (bullet.test(line)) bullets.push(line);
    else if (bullets.length && line.trim()) break;
  }
  return bullets.join('\n');
}

function readSection(root, section) {
  for (const file of [path.join(root, 'atris.md'), path.join(root, 'atris', 'atris.md')]) {
    if (!fs.existsSync(file)) continue;
    const found = extractSection(fs.readFileSync(file, 'utf8'), section);
    if (found) return found;
  }
  return '';
}

// init writes the adapters before it copies atris.md, so a new project reads the package copy.
const sectionForRoot = (root, section) => readSection(root, section) || readSection(PACKAGE_ROOT, section);

const extractOpeningLines = (content) => extractSection(content, SECTIONS.opening);
const openingLinesForRoot = (root = process.cwd()) => sectionForRoot(root, SECTIONS.opening);
const extractScreensRules = (content) => extractSection(content, SECTIONS.screens);
const screensRulesForRoot = (root = process.cwd()) => sectionForRoot(root, SECTIONS.screens);

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

// Existing files predate the copy. Replace a marked copy in place; otherwise
// put it right before `## You translate` (the atris-written layout), before
// the brain compile block, or at the end. An empty file starts with emptyTop.
function placeBlock(source, block, { start: START, end: END }, emptyTop = '') {
  const start = source.indexOf(START);
  const end = source.indexOf(END, start + START.length);
  if (start !== -1 && end !== -1) return `${source.slice(0, start)}${block}${source.slice(end + END.length)}`;
  const anchor = ['\n## You translate', '\n<!-- ATRIS_BRAIN_COMPILE:START -->']
    .map((marker) => source.indexOf(marker))
    .find((index) => index !== -1);
  if (anchor !== undefined) return `${source.slice(0, anchor).trimEnd()}\n\n${block}\n${source.slice(anchor)}`;
  const top = source.trimEnd() || emptyTop;
  return `${top}${top ? '\n\n' : ''}${block}\n`;
}

function upsertAgentsOpeningLines(filePath, bullets, options = {}) {
  const block = renderAgentsOpeningBlock(bullets);
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (!block) return { action: 'unchanged', content: source };
  const content = placeBlock(source, block, SECTIONS.opening, '# AGENTS');
  const changed = content !== source;
  if (changed && !options.dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { action: source ? (changed ? 'updated' : 'unchanged') : 'created', content };
}

// The screens block goes into each start-up file that exists. Returns the files that changed, relative to root.
function upsertScreensAdapters(root, bullets, options = {}) {
  if (!bullets) return [];
  const block = `${SECTIONS.screens.start}\n## Screens\n\n${bullets}\n${SECTIONS.screens.end}`;
  const changed = [];
  for (const rel of SCREENS_FILES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const content = placeBlock(source, block, SECTIONS.screens);
    if (content === source) continue;
    if (!options.dryRun) fs.writeFileSync(file, content, 'utf8');
    changed.push(rel);
  }
  return changed;
}

module.exports = {
  extractOpeningLines,
  extractScreensRules,
  openingLinesForRoot,
  screensRulesForRoot,
  upsertScreensAdapters,
  renderAgentsOpeningBlock,
  renderOpeningLinesBlock,
  upsertAgentsOpeningLines,
};
