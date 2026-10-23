'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  OLD_ROSTER_NOTE,
  ROSTER_NOTE,
  scanRosterMarkdown,
} = require('../lib/roster-markdown');

test('is a single > note line that matches a roster line after trim', () => {
  assert.equal(typeof OLD_ROSTER_NOTE, 'string');
  assert.ok(OLD_ROSTER_NOTE.length > 0);
  // One line only, or the exact line match in sectionedRosterText can never hit.
  assert.ok(!OLD_ROSTER_NOTE.includes('\n'));
  assert.ok(!OLD_ROSTER_NOTE.includes('\r'));
  // It starts with > and carries no surrounding whitespace, so a raw line or a
  // trimmed line both equal it.
  assert.ok(OLD_ROSTER_NOTE.startsWith('>'));
  assert.equal(OLD_ROSTER_NOTE.trim(), OLD_ROSTER_NOTE);
  assert.equal(OLD_ROSTER_NOTE.trim() === OLD_ROSTER_NOTE, true);
  assert.equal(`  ${OLD_ROSTER_NOTE}  `.trim(), OLD_ROSTER_NOTE);
});

test('documents the old one-line job shape', () => {
  assert.ok(OLD_ROSTER_NOTE.includes('job:'));
  assert.ok(OLD_ROSTER_NOTE.includes('(low, medium, high, xhigh, max)'));
  assert.ok(OLD_ROSTER_NOTE.includes('backup'));
  assert.ok(OLD_ROSTER_NOTE.includes('max 20 min'));
  assert.ok(OLD_ROSTER_NOTE.includes('until'));
  assert.ok(OLD_ROSTER_NOTE.includes('the year is required'));
});

test('the scanner never reads the note as a job or team entry', () => {
  const only = scanRosterMarkdown(OLD_ROSTER_NOTE);
  assert.equal(only.entries.length, 0);
  assert.equal(only.headings.length, 0);

  const doc = ['# roster', '', OLD_ROSTER_NOTE, '', 'build: claude opus 5.5', ''].join('\n');
  const scan = scanRosterMarkdown(doc);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0].name, 'build');
  assert.equal(scan.entries[0].value, 'claude opus 5.5');
});

test('empty files have no old note and the note differs from its replacement', () => {
  for (const text of ['', '\n', '  \n\n  \n']) {
    const scan = scanRosterMarkdown(text);
    assert.equal(scan.lines.some((line) => line.trim() === OLD_ROSTER_NOTE), false);
  }
  // sectionedRosterText swaps OLD_ROSTER_NOTE for ROSTER_NOTE; they must be
  // different strings or the swap would be a no-op.
  assert.notStrictEqual(OLD_ROSTER_NOTE, ROSTER_NOTE);
  assert.ok(ROSTER_NOTE.startsWith('>'));
});
