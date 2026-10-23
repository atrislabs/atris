const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeWikiStatus } = require('../lib/wiki');

const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wiki-status-'));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const REPORT = { health: '3 pages compiled', nextMove: 'run atris lint' };

test('writes the status file with every field and returns its path', () => {
  const root = makeRoot();
  const statusPath = writeWikiStatus(root, REPORT, 'public', {
    lastIngest: '2026-01-02 08:15',
    lastLint: '2026-01-03 09:00',
    lastLoop: '2026-01-04 10:30',
  });

  assert.strictEqual(statusPath, path.join(root, 'atris', 'wiki', 'STATUS.md'));
  assert.strictEqual(
    fs.readFileSync(statusPath, 'utf8'),
    [
      '# Atris Wiki Status',
      '',
      '- Last ingest: 2026-01-02 08:15',
      '- Last lint: 2026-01-03 09:00',
      '- Last loop: 2026-01-04 10:30',
      '- Health: 3 pages compiled',
      '- Next move: run atris lint',
      '',
    ].join('\n')
  );
});

test('creates the wiki scaffold around the status file on a fresh project', () => {
  const root = makeRoot();
  writeWikiStatus(root, REPORT, 'public', { lastLoop: '2026-01-04 10:30' });

  const wikiDir = path.join(root, 'atris', 'wiki');
  for (const file of ['wiki.md', 'index.md', 'log.md', 'STATUS.md']) {
    assert.ok(fs.existsSync(path.join(wikiDir, file)), `${file} should exist`);
  }
  for (const dir of ['people', 'systems', 'concepts', 'briefs']) {
    assert.ok(fs.statSync(path.join(wikiDir, dir)).isDirectory(), `${dir}/ should exist`);
  }
});

test('with no prior file and no overrides, ingest and lint read "never"', () => {
  const root = makeRoot();
  const statusPath = writeWikiStatus(root, REPORT, 'public', { lastLoop: '2026-01-04 10:30' });
  const content = fs.readFileSync(statusPath, 'utf8');

  assert.match(content, /^- Last ingest: never$/m);
  assert.match(content, /^- Last lint: never$/m);
  assert.match(content, /^- Last loop: 2026-01-04 10:30$/m);
});

test('keeps the earlier ingest and lint times when a later write does not override them', () => {
  const root = makeRoot();
  writeWikiStatus(root, REPORT, 'public', {
    lastIngest: '2026-01-02 08:15',
    lastLint: '2026-01-03 09:00',
    lastLoop: '2026-01-04 10:30',
  });

  const statusPath = writeWikiStatus(
    root,
    { health: 'all clear', nextMove: 'ingest more notes' },
    'public',
    { lastLoop: '2026-01-05 11:45' }
  );
  const content = fs.readFileSync(statusPath, 'utf8');

  assert.match(content, /^- Last ingest: 2026-01-02 08:15$/m);
  assert.match(content, /^- Last lint: 2026-01-03 09:00$/m);
  assert.match(content, /^- Last loop: 2026-01-05 11:45$/m);
  assert.match(content, /^- Health: all clear$/m);
  assert.match(content, /^- Next move: ingest more notes$/m);
  assert.ok(!content.includes('3 pages compiled'), 'old health text should be replaced');
});

test('an override wins over the value already on disk', () => {
  const root = makeRoot();
  writeWikiStatus(root, REPORT, 'public', {
    lastIngest: '2026-01-02 08:15',
    lastLoop: '2026-01-04 10:30',
  });

  const statusPath = writeWikiStatus(root, REPORT, 'public', {
    lastIngest: '2026-02-01 07:00',
    lastLoop: '2026-02-01 07:05',
  });
  const content = fs.readFileSync(statusPath, 'utf8');

  assert.match(content, /^- Last ingest: 2026-02-01 07:00$/m);
  assert.ok(!content.includes('2026-01-02 08:15'));
});

test('an empty-string override falls back to the value on disk', () => {
  const root = makeRoot();
  writeWikiStatus(root, REPORT, 'public', {
    lastIngest: '2026-01-02 08:15',
    lastLoop: '2026-01-04 10:30',
  });

  const statusPath = writeWikiStatus(root, REPORT, 'public', {
    lastIngest: '',
    lastLoop: '2026-01-05 11:45',
  });

  assert.match(fs.readFileSync(statusPath, 'utf8'), /^- Last ingest: 2026-01-02 08:15$/m);
});

test('reads a hand-edited status file loosely and rewrites it in the standard shape', () => {
  const root = makeRoot();
  const wikiDir = path.join(root, 'atris', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(
    path.join(wikiDir, 'STATUS.md'),
    [
      '# Custom heading',
      '',
      'A stray paragraph someone typed.',
      '- Last ingest:    2026-03-01 12:00',
      '- Last lint: 2026-03-02 13:00',
      '- Something else: ignored',
      '',
    ].join('\n'),
    'utf8'
  );

  const statusPath = writeWikiStatus(root, REPORT, 'public', { lastLoop: '2026-03-03 14:00' });

  assert.strictEqual(
    fs.readFileSync(statusPath, 'utf8'),
    [
      '# Atris Wiki Status',
      '',
      '- Last ingest: 2026-03-01 12:00',
      '- Last lint: 2026-03-02 13:00',
      '- Last loop: 2026-03-03 14:00',
      '- Health: 3 pages compiled',
      '- Next move: run atris lint',
      '',
    ].join('\n')
  );
});

test('private mode writes under .atris/presidio and leaves the public wiki alone', () => {
  const root = makeRoot();
  const statusPath = writeWikiStatus(root, REPORT, 'private', { lastLoop: '2026-01-04 10:30' });

  assert.strictEqual(statusPath, path.join(root, '.atris', 'presidio', 'STATUS.md'));
  assert.match(fs.readFileSync(statusPath, 'utf8'), /^- Health: 3 pages compiled$/m);
  assert.ok(!fs.existsSync(path.join(root, 'atris', 'wiki')), 'public wiki should not be created');
});

test('throws when the report is missing and leaves the starter status file untouched', () => {
  const root = makeRoot();

  assert.throws(() => writeWikiStatus(root, undefined, 'public', { lastLoop: '2026-01-04 10:30' }), TypeError);

  const content = fs.readFileSync(path.join(root, 'atris', 'wiki', 'STATUS.md'), 'utf8');
  assert.match(content, /^- Health: wiki scaffold created, no pages yet$/m);
  assert.ok(!content.includes('2026-01-04 10:30'));
});
