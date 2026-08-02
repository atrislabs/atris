const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { knownCommands } = require('../lib/known-commands.js');

// Standing lesson (burned us twice): prompt/doc text naming commands that do
// not exist. atris.md, atris/CLAUDE.md, and the templates under templates/ are
// copied verbatim into every user project by init/update. When one of them tells
// a new person to run `atris <cmd>` and <cmd> was never wired up (renamed,
// removed, or typo'd), the first thing they try dead-ends. This turns that into
// a loud test failure at build time instead of a silent wall for the user.

const repoRoot = path.join(__dirname, '..');
const known = new Set(knownCommands);

function walkMarkdown(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(p, acc);
    else if (entry.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

// The distribution-critical docs: what init/update copy into user projects,
// plus the two root guides a new project reads first.
function distributionDocs() {
  const singles = ['atris.md', 'atris/CLAUDE.md', 'atris/atris.md', 'README.md']
    .map((f) => path.join(repoRoot, f))
    .filter((f) => fs.existsSync(f));
  const templates = walkMarkdown(path.join(repoRoot, 'templates'), []);
  return [...singles, ...templates];
}

// Only pull `atris <cmd>` references out of code contexts — inline `code`
// spans and fenced ``` blocks. Prose like "atris builds it" is not a command
// reference and must not be flagged; command references in these docs are always
// written as code. cmd is the first bare word, e.g. `atris mission run ...` -> mission.
function commandRefs(text) {
  const spans = [];
  const fence = /```[\s\S]*?```/g;
  let f;
  while ((f = fence.exec(text)) !== null) spans.push(f[0]);
  const inline = /`([^`\n]+)`/g;
  let i;
  while ((i = inline.exec(text)) !== null) spans.push(i[1]);

  const out = [];
  const cmdRe = /(?:^|\s|\$\s*)atris +([a-z][a-z-]+)/g;
  for (const span of spans) {
    let m;
    while ((m = cmdRe.exec(span)) !== null) out.push(m[1]);
  }
  return out;
}

test('lib/known-commands exposes a non-empty command list', () => {
  assert.ok(knownCommands.length > 0, 'knownCommands must not be empty');
});

test('every atris command named in distribution docs is a real command', () => {
  const docs = distributionDocs();
  assert.ok(docs.length > 0, 'expected distribution docs (atris.md, templates/) to exist');

  let refCount = 0;
  const unknown = [];
  for (const doc of docs) {
    const text = fs.readFileSync(doc, 'utf8');
    for (const cmd of commandRefs(text)) {
      refCount += 1;
      if (!known.has(cmd)) {
        unknown.push(`${path.relative(repoRoot, doc)}: atris ${cmd}`);
      }
    }
  }

  // Guard against the extractor silently matching nothing (a vacuous pass).
  assert.ok(refCount > 20, `expected to find real command refs in docs, found ${refCount}`);
  assert.deepEqual(
    unknown,
    [],
    `docs reference atris commands that lib/known-commands.js does not define ` +
      `(rename, remove, or fix the typo):\n  ${unknown.join('\n  ')}`
  );
});
