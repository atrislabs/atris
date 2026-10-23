const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWikiStatus } = require('../lib/wiki');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-read-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeStatus(root, relativeDir, content) {
  const wikiDir = path.join(root, relativeDir);
  fs.mkdirSync(wikiDir, { recursive: true });
  const statusPath = path.join(wikiDir, 'STATUS.md');
  fs.writeFileSync(statusPath, content);
  return { wikiDir, statusPath };
}

test('readWikiStatus returns the first four exact bullet lines from the canonical wiki', (t) => {
  const root = fixture(t);
  const paths = writeStatus(root, 'atris/wiki', [
    '# Status', '', '- Last ingest: 2025-01-02', '  - nested',
    '* alternate marker', '- Health: good', '- ', 'plain text',
    '- Next move: review', '- Fifth bullet: omitted', '',
  ].join('\n'));
  writeStatus(root, 'wiki', '- legacy status');

  assert.deepStrictEqual(readWikiStatus(root), {
    ...paths,
    bullets: ['- Last ingest: 2025-01-02', '- Health: good', '- ', '- Next move: review'],
  });
});

test('readWikiStatus searches legacy and slug folders in priority order', (t) => {
  const root = fixture(t);
  const slugPaths = writeStatus(root, 'example/wiki', '- slug');
  assert.deepStrictEqual(readWikiStatus(root, 'example'), { ...slugPaths, bullets: ['- slug'] });

  const nestedPaths = writeStatus(root, 'atris/example/wiki', '- nested slug');
  assert.deepStrictEqual(readWikiStatus(root, 'example'), { ...nestedPaths, bullets: ['- nested slug'] });

  const legacyPaths = writeStatus(root, 'wiki', '- legacy');
  assert.deepStrictEqual(readWikiStatus(root, 'example'), { ...legacyPaths, bullets: ['- legacy'] });
});

test('readWikiStatus returns null for no wiki and empty bullets for missing or empty status', (t) => {
  const root = fixture(t);
  assert.strictEqual(readWikiStatus(root), null);
  const wikiDir = path.join(root, 'atris/wiki');
  const statusPath = path.join(wikiDir, 'STATUS.md');
  fs.mkdirSync(wikiDir, { recursive: true });
  assert.deepStrictEqual(readWikiStatus(root), { wikiDir, statusPath, bullets: [] });
  fs.writeFileSync(statusPath, '');
  assert.deepStrictEqual(readWikiStatus(root), { wikiDir, statusPath, bullets: [] });
  fs.writeFileSync(statusPath, '# Status\nNo bullet lines.\n');
  assert.deepStrictEqual(readWikiStatus(root), { wikiDir, statusPath, bullets: [] });
});

test('readWikiStatus private mode reads only the private wiki', (t) => {
  const root = fixture(t);
  writeStatus(root, 'atris/wiki', '- public');
  assert.strictEqual(readWikiStatus(root, 'example', 'private'), null);
  const paths = writeStatus(root, '.atris/presidio', '- private');
  assert.deepStrictEqual(readWikiStatus(root, 'example', 'private'), {
    ...paths, bullets: ['- private'],
  });
});
