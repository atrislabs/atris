const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { wikiMetabolismNudge } = require('../lib/wiki');

const NUDGE = 'the wiki has grown a lot since its last pruning; run: atris wiki consolidate';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wiki-nudge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function wikiDir(root, mode) {
  return path.join(root, mode === 'private' ? '.atris/presidio' : 'atris/wiki');
}

function writeIndex(root, count, mode = 'public') {
  const dir = wikiDir(root, mode);
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, index) => `- entry ${index}`);
  fs.writeFileSync(path.join(dir, 'index.md'), `# index\n\n${lines.join('\n')}\n`, 'utf8');
  return dir;
}

function writePages(root, folder, count) {
  const dir = path.join(root, 'atris', 'wiki', folder);
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(dir, `page-${index}.md`), `# page ${index}\n`, 'utf8');
  }
}

function writeMarker(root, counts) {
  const markerPath = path.join(root, '.atris', 'state', 'wiki.metabolism.json');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify({
    lastConsolidatedAt: '2020-01-15T00:00:00.000Z',
    entryCountAtConsolidation: counts,
  }, null, 2)}\n`, 'utf8');
}

test('a small wiki returns no nudge', (t) => {
  const root = tempRoot(t);
  const dir = writeIndex(root, 3);
  fs.mkdirSync(path.join(dir, 'concepts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'concepts', 'one.md'), '# one\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'log.md'), '# log\n\n- 09:00 INGEST one\n  - detail stays nested\n', 'utf8');

  assert.strictEqual(wikiMetabolismNudge(root), '');
  assert.strictEqual(wikiMetabolismNudge(root, 'public'), '');
});

test('the nudge starts only past the budget and growth edges', (t) => {
  const atBudget = tempRoot(t);
  writeIndex(atBudget, 40);
  assert.strictEqual(wikiMetabolismNudge(atBudget), '');

  const overBudget = tempRoot(t);
  writeIndex(overBudget, 41);
  assert.strictEqual(wikiMetabolismNudge(overBudget), NUDGE);
  assert.strictEqual(wikiMetabolismNudge(overBudget, 'PRIVATE'), NUDGE);
  assert.strictEqual(wikiMetabolismNudge(overBudget, 'private'), '');

  const grewNine = tempRoot(t);
  writePages(grewNine, 'systems', 9);
  writeMarker(grewNine, { 'systems/': 0 });
  assert.strictEqual(wikiMetabolismNudge(grewNine), '');

  const grewTen = tempRoot(t);
  writePages(grewTen, 'systems', 10);
  writeMarker(grewTen, { 'systems/': 0 });
  assert.strictEqual(wikiMetabolismNudge(grewTen), NUDGE);

  const shrunk = tempRoot(t);
  writePages(shrunk, 'concepts', 2);
  writeMarker(shrunk, { 'concepts/': 12 });
  assert.strictEqual(wikiMetabolismNudge(shrunk), '');

  const privateRoot = tempRoot(t);
  writeIndex(privateRoot, 41, 'private');
  assert.strictEqual(wikiMetabolismNudge(privateRoot, 'private'), NUDGE);
  assert.strictEqual(wikiMetabolismNudge(privateRoot, 'public'), '');
});

test('an empty wiki and a broken surface stay quiet', (t) => {
  const empty = tempRoot(t);
  assert.strictEqual(wikiMetabolismNudge(empty), '');

  const broken = tempRoot(t);
  fs.mkdirSync(path.join(broken, 'atris', 'wiki', 'index.md'), { recursive: true });
  assert.strictEqual(wikiMetabolismNudge(broken), '');

  const badMarker = tempRoot(t);
  writeIndex(badMarker, 2);
  const markerPath = path.join(badMarker, '.atris', 'state', 'wiki.metabolism.json');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, '{not json', 'utf8');
  assert.strictEqual(wikiMetabolismNudge(badMarker), '');

  assert.strictEqual(wikiMetabolismNudge(null), '');
});
