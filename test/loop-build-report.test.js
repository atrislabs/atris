'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReport } = require('../commands/loop');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loop-report-'));
}

test('buildReport on a fresh wiki reports good shape with a zeroed breakdown', () => {
  const dir = makeRoot();
  try {
    const r = buildReport(dir); // ensureWikiScaffold runs inside
    assert.match(r.health, /good shape/);
    assert.equal(r.pageCount, 0);
    assert.equal(r.stalePages.length, 0);
    assert.equal(r.orphanPages.length, 0);
    assert.equal(r.nextSources.length, 0);
    assert.deepEqual(r.details, ['pages=0', 'stale=0', 'orphans=0', 'suggested=0']);
    assert.ok(r.wikiDir.endsWith(path.join('atris', 'wiki')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildReport surfaces an unlinked page as an orphan and points the next move at linking', () => {
  const dir = makeRoot();
  try {
    buildReport(dir); // scaffold first
    const concepts = path.join(dir, 'atris', 'wiki', 'concepts');
    fs.mkdirSync(concepts, { recursive: true });
    fs.writeFileSync(path.join(concepts, 'lonely.md'), '---\ntitle: Lonely\n---\n\nNo inbound links.\n');

    const r = buildReport(dir);
    assert.equal(r.pageCount, 1);
    assert.equal(r.orphanPages.length, 1);
    assert.match(r.health, /orphan/);
    assert.match(r.nextMove, /link|index/i);
    assert.equal(r.details[2], 'orphans=1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
