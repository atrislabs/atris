const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordWikiConsolidation } = require('../lib/wiki');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-consolidation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content = '# page\n') {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function savedCounts(root) {
  // The timestamp is generated internally and is deliberately not asserted.
  return JSON.parse(fs.readFileSync(
    path.join(root, '.atris/state/wiki.metabolism.json'), 'utf8'
  )).entryCountAtConsolidation;
}

test('records public wiki bullet and recursive markdown page counts', (t) => {
  const root = fixture(t);
  write(root, 'atris/wiki/index.md', '# index\n- first\n  - nested\n* ignored\n-   \n');
  write(root, 'atris/wiki/log.md', '# log\n- event\n  - detail\n- another\n');
  write(root, 'atris/wiki/people/person.md');
  write(root, 'atris/wiki/people/nested/other.md');
  write(root, 'atris/wiki/people/notes.txt');
  write(root, 'atris/wiki/systems/tool.md');
  write(root, 'atris/wiki/concepts/idea.md');
  write(root, 'atris/wiki/briefs/summary.md');
  write(root, 'atris/wiki/unrelated/ignored.md');
  const expected = {
    'index.md': 2, 'log.md': 2, 'people/': 2,
    'systems/': 1, 'concepts/': 1, 'briefs/': 1,
  };

  const result = recordWikiConsolidation(root);

  assert.deepStrictEqual(result.entryCountAtConsolidation, expected);
  assert.deepStrictEqual(savedCounts(root), expected);
  assert.strictEqual(fs.readFileSync(path.join(root, 'atris/wiki/people/person.md'), 'utf8'), '# page\n');
});

test('private mode replaces an existing marker using only private wiki counts', (t) => {
  const root = fixture(t);
  write(root, 'atris/wiki/people/public.md');
  write(root, '.atris/presidio/index.md', '- private\n');
  write(root, '.atris/presidio/concepts/nested/private.md');
  write(root, '.atris/state/wiki.metabolism.json', JSON.stringify({
    lastConsolidatedAt: '2000-01-01T00:00:00.000Z',
    entryCountAtConsolidation: { 'people/': 99, obsolete: 5 },
  }));
  const expected = {
    'index.md': 1, 'log.md': 0, 'people/': 0,
    'systems/': 0, 'concepts/': 1, 'briefs/': 0,
  };

  const result = recordWikiConsolidation(root, 'private');

  assert.deepStrictEqual(result.entryCountAtConsolidation, expected);
  assert.deepStrictEqual(savedCounts(root), expected);
});

test('a missing wiki records zero counts without creating a wiki scaffold', (t) => {
  const root = fixture(t);
  const expected = {
    'index.md': 0, 'log.md': 0, 'people/': 0,
    'systems/': 0, 'concepts/': 0, 'briefs/': 0,
  };

  const result = recordWikiConsolidation(root);

  assert.deepStrictEqual(result.entryCountAtConsolidation, expected);
  assert.deepStrictEqual(savedCounts(root), expected);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/wiki')), false);
});
