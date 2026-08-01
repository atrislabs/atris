const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  WIKI_METABOLISM_MARKER,
  countWikiMetabolismEntries,
  findWikiMetabolismFindings,
  readWikiMetabolismMarker,
  writeWikiMetabolismMarker,
} = require('../lib/wiki');

const WIKI_FOLDERS = ['people', 'systems', 'concepts', 'briefs'];

function createWikiFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wiki-metabolism-'));
  const wikiDir = path.join(root, 'atris', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const indexEntries = options.indexEntries || [];
  const logEntries = options.logEntries || [];
  fs.writeFileSync(path.join(wikiDir, 'index.md'), `# index\n\n${indexEntries.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(wikiDir, 'log.md'), `# log\n\n${logEntries.join('\n')}\n`, 'utf8');

  for (const folder of WIKI_FOLDERS) {
    const folderDir = path.join(wikiDir, folder);
    fs.mkdirSync(folderDir, { recursive: true });
    const pageCount = options.pages?.[folder] || 0;
    for (let index = 0; index < pageCount; index++) {
      fs.writeFileSync(path.join(folderDir, `page-${index}.md`), `# page ${index}\n`, 'utf8');
    }
  }

  return { root, wikiDir };
}

test('counts index bullets, log entries, and pages per wiki folder', (t) => {
  const { root } = createWikiFixture(t, {
    indexEntries: ['- person', '  - nested convention', '- system'],
    logEntries: ['- 09:00 INGEST first', '  - detail does not count', '- 10:00 LINT second'],
    pages: { people: 2, systems: 1, concepts: 3, briefs: 1 },
  });

  assert.deepEqual(countWikiMetabolismEntries(root), {
    'index.md': 3,
    'log.md': 2,
    'people/': 2,
    'systems/': 1,
    'concepts/': 3,
    'briefs/': 1,
  });
});

test('reports an over-budget finding only after a surface exceeds its default budget', (t) => {
  const indexEntries = Array.from({ length: 41 }, (_, index) => `- entry ${index}`);
  const { root } = createWikiFixture(t, { indexEntries });

  const finding = findWikiMetabolismFindings(root)
    .find((item) => item.code === 'over-budget' && item.surface === 'index.md');

  assert.ok(finding);
  assert.equal(finding.count, 41);
  assert.equal(finding.budget, 40);
});

test('reports consolidation due after a surface grows by ten entries', (t) => {
  const { root, wikiDir } = createWikiFixture(t, { pages: { systems: 1 } });
  writeWikiMetabolismMarker(root, countWikiMetabolismEntries(root), '2026-08-01T10:00:00.000Z');

  for (let index = 1; index <= 10; index++) {
    fs.writeFileSync(path.join(wikiDir, 'systems', `growth-${index}.md`), `# growth ${index}\n`, 'utf8');
  }

  const finding = findWikiMetabolismFindings(root)
    .find((item) => item.code === 'consolidation-due' && item.surface === 'systems/');

  assert.ok(finding);
  assert.equal(finding.baselineCount, 1);
  assert.equal(finding.count, 11);
  assert.equal(finding.growth, 10);
});

test('writes and reads the metabolism marker without changing its data', (t) => {
  const { root } = createWikiFixture(t);
  const counts = {
    'index.md': 4,
    'log.md': 7,
    'people/': 2,
    'systems/': 3,
    'concepts/': 5,
    'briefs/': 1,
  };
  const timestamp = '2026-08-01T11:22:33.000Z';

  const written = writeWikiMetabolismMarker(root, counts, timestamp);

  assert.deepEqual(readWikiMetabolismMarker(root), written);
  assert.equal(fs.existsSync(path.join(root, WIKI_METABOLISM_MARKER)), true);
});

test('wiki consolidate prints pruning keep rules and records current counts', (t) => {
  const { root } = createWikiFixture(t, {
    indexEntries: ['- durable fact'],
    logEntries: ['- 09:00 INGEST fact'],
    pages: { concepts: 1 },
  });
  const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

  const result = spawnSync(process.execPath, [cliPath, 'wiki', 'consolidate'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\bUPDATE facts that changed\b/);
  assert.match(result.stdout, /\bDELETE stale facts, duplicates, and mechanics\b/);
  assert.match(result.stdout, /\bADD nothing new\b/);
  assert.match(result.stdout, /user-stated conventions or explicit remember-this survive/);
  assert.match(result.stdout, /Every kept entry keeps its provenance as a source link or date/);
  assert.deepEqual(readWikiMetabolismMarker(root).entryCountAtConsolidation, countWikiMetabolismEntries(root));
});
