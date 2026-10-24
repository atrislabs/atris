const test = require('node:test');
const assert = require('node:assert');
const journal = require('../lib/journal');

test('timestamps match only when valid and less than five milliseconds apart', () => {
  const base = '2026-10-23T12:00:00.000Z';
  assert.strictEqual(journal.isSameTimestamp(base, base), true);
  assert.strictEqual(journal.isSameTimestamp(base, '2026-10-23T12:00:00.004Z'), true);
  assert.strictEqual(journal.isSameTimestamp('2026-10-23T12:00:00.004Z', base), true);
  assert.strictEqual(journal.isSameTimestamp(base, '2026-10-23T12:00:00.005Z'), false);
  assert.strictEqual(journal.isSameTimestamp(base, 'invalid'), false);
  assert.strictEqual(journal.isSameTimestamp('', base), false);
  assert.strictEqual(journal.isSameTimestamp(base, null), false);
});

test('content hashing uses SHA-256 and normalizes CRLF line endings', () => {
  assert.strictEqual(journal.computeContentHash('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.strictEqual(journal.computeContentHash('one\r\ntwo\r\n'),
    journal.computeContentHash('one\ntwo\n'));
  assert.notStrictEqual(journal.computeContentHash('one\ntwo'),
    journal.computeContentHash('one\ntwo\n'));
  for (const value of [undefined, null, 42, {}, []]) {
    assert.strictEqual(journal.computeContentHash(value), null);
  }
});

test('journal parsing retains headings, preamble, and nested headings', () => {
  assert.deepStrictEqual(journal.parseJournalSections(
    '# Daily log\n\n## Notes\nA note\n### Detail\nMore\n## Inbox\nAn idea\n'
  ), {
    __header__: '# Daily log\n\n',
    Notes: '## Notes\nA note\n### Detail\nMore\n',
    Inbox: '## Inbox\nAn idea\n',
  });
  assert.deepStrictEqual(journal.parseJournalSections(''), { __header__: '' });
});

test('reconstruction puts standard sections before custom sections', () => {
  assert.strictEqual(journal.reconstructJournal({
    Custom: 'custom\n',
    Inbox: 'inbox\n',
    Notes: 'notes\n',
    __header__: 'header\n',
    Handoff: 'handoff\n',
  }), 'header\nhandoff\nnotes\ninbox\ncustom\n');
  assert.strictEqual(journal.reconstructJournal({}), '');
});

test('merge keeps unique sections and flags differing shared sections', () => {
  const local = { Notes: 'local note', Backlog: 'local task', Inbox: 'same' };
  const remote = { Notes: 'remote note', Handoff: 'remote handoff', Inbox: 'same' };
  const localBefore = { ...local };
  const remoteBefore = { ...remote };
  assert.deepStrictEqual(journal.mergeSections(local, remote), {
    merged: {
      Notes: 'local note', Backlog: 'local task', Inbox: 'same', Handoff: 'remote handoff',
    },
    conflicts: ['Notes'],
  });
  assert.deepStrictEqual(local, localBefore);
  assert.deepStrictEqual(remote, remoteBefore);
});

test('merge prefers local edits without conflict when the known remote hash matches', () => {
  const local = { Notes: 'local edit' };
  const remote = { Notes: 'previous note' };
  const knownHash = journal.computeContentHash(journal.reconstructJournal(remote));
  assert.deepStrictEqual(journal.mergeSections(local, remote, knownHash), {
    merged: { Notes: 'local edit' }, conflicts: [],
  });
  assert.deepStrictEqual(journal.mergeSections(local, remote, 'stale hash'), {
    merged: { Notes: 'local edit' }, conflicts: ['Notes'],
  });
});
