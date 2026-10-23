'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addInboxIdea } = require('../lib/file-ops');

function makeTempDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-add-inbox-idea-'));
  process.env.HOME = tmpDir;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  return tmpDir;
}

test('addInboxIdea adds ideas sequentially to an existing inbox', (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const logFile = path.join(tmpDir, '2026-01-01.md');
  const initial = '# Log, 2026-01-01\n\n## Inbox\n\n(Empty - inbox zero achieved)\n\n---\n\n## Notes\n';
  fs.writeFileSync(logFile, initial, 'utf8');

  const id1 = addInboxIdea(logFile, 'first task');
  assert.strictEqual(id1, 1);
  const afterFirst = fs.readFileSync(logFile, 'utf8');
  assert.ok(afterFirst.includes('- **I1:** first task'));
  assert.ok(!afterFirst.includes('(Empty - inbox zero achieved)'));

  const id2 = addInboxIdea(logFile, 'second task');
  assert.strictEqual(id2, 2);
  const afterSecond = fs.readFileSync(logFile, 'utf8');
  assert.ok(afterSecond.includes('- **I2:** second task'));
  assert.ok(afterSecond.includes('- **I1:** first task'));
  assert.ok(afterSecond.indexOf('- **I2:**') < afterSecond.indexOf('- **I1:**'));
});

test('addInboxIdea handles edge cases: missing inbox section, gapped IDs, and CRLF endings', (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. Missing inbox section in file
  const noInboxFile = path.join(tmpDir, 'no-inbox.md');
  fs.writeFileSync(noInboxFile, '# Log\n\n## Notes\nJust notes.\n', 'utf8');
  const idMissing = addInboxIdea(noInboxFile, 'created section idea');
  assert.strictEqual(idMissing, 1);
  const noInboxContent = fs.readFileSync(noInboxFile, 'utf8');
  assert.ok(noInboxContent.includes('## Inbox'));
  assert.ok(noInboxContent.includes('- **I1:** created section idea'));

  // 2. Gapped existing IDs (picks max + 1)
  const gappedFile = path.join(tmpDir, 'gapped.md');
  fs.writeFileSync(
    gappedFile,
    '# Log\n\n## Inbox\n\n- **I8:** item eight\n- **I3:** item three\n\n---\n',
    'utf8'
  );
  const idGapped = addInboxIdea(gappedFile, 'item nine');
  assert.strictEqual(idGapped, 9);
  const gappedContent = fs.readFileSync(gappedFile, 'utf8');
  assert.ok(gappedContent.includes('- **I9:** item nine'));
  assert.ok(gappedContent.indexOf('- **I9:**') < gappedContent.indexOf('- **I8:**'));

  // 3. CRLF line endings without duplicating sections
  const crlfFile = path.join(tmpDir, 'crlf.md');
  fs.writeFileSync(
    crlfFile,
    '# Log\r\n\r\n## Inbox\r\n\r\n- **I1:** existing item\r\n\r\n---\r\n',
    'utf8'
  );
  const idCrlf = addInboxIdea(crlfFile, 'second item');
  assert.strictEqual(idCrlf, 2);
  const crlfContent = fs.readFileSync(crlfFile, 'utf8');
  const inboxOccurrences = crlfContent.match(/## Inbox/g) || [];
  assert.strictEqual(inboxOccurrences.length, 1);
  assert.ok(crlfContent.includes('- **I2:** second item'));
});

test('addInboxIdea throws ENOENT when file does not exist', (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const missingFile = path.join(tmpDir, 'nonexistent.md');
  assert.throws(
    () => {
      addInboxIdea(missingFile, 'doomed idea');
    },
    { code: 'ENOENT' }
  );
});
