'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTeamMemberJournal } = require('../lib/todo-fallback');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('returns the latest markdown journal with parsed fields and unchanged raw content', t => {
  const root = fixture(t);
  const journal = path.join(root, 'team', 'alex', 'journal');
  fs.mkdirSync(journal, { recursive: true });
  const raw = '# Journal\n\n**Task:**   Repair export  \n**Delivered:** Working export\n**Pattern:** Check inputs\n**Learned:** Keep fixtures small\n';
  // Write the older entry last so selection must use names, not creation order.
  fs.writeFileSync(path.join(journal, '2024-06-12.md'), raw);
  fs.writeFileSync(path.join(journal, '2024-06-11.md'), '**Task:** Older task\n');
  fs.writeFileSync(path.join(journal, '2099-01-01.txt'), 'Ignore this file');

  assert.deepStrictEqual(getTeamMemberJournal(root, 'alex'), {
    date: '2024-06-12',
    file: path.join(journal, '2024-06-12.md'),
    task: 'Repair export',
    delivered: 'Working export',
    pattern: 'Check inputs',
    learned: 'Keep fixtures small',
    raw,
  });
});

test('returns null fields for an empty latest entry instead of falling back to an older entry', t => {
  const root = fixture(t);
  const journal = path.join(root, 'team', 'alex', 'journal');
  fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, '2024-06-11.md'), '**Task:** Older task\n');
  fs.writeFileSync(path.join(journal, '2024-06-12.md'), '');

  assert.deepStrictEqual(getTeamMemberJournal(root, 'alex'), {
    date: '2024-06-12',
    file: path.join(journal, '2024-06-12.md'),
    task: null,
    delivered: null,
    pattern: null,
    learned: null,
    raw: '',
  });
});

test('returns null for missing journals and folders without markdown entries', t => {
  const root = fixture(t);
  assert.strictEqual(getTeamMemberJournal(root, 'missing'), null);

  const journal = path.join(root, 'team', 'alex', 'journal');
  fs.mkdirSync(journal, { recursive: true });
  assert.strictEqual(getTeamMemberJournal(root, 'alex'), null);
  fs.writeFileSync(path.join(journal, 'notes.txt'), '**Task:** Not markdown');
  assert.strictEqual(getTeamMemberJournal(root, 'alex'), null);
});

test('returns null when the journal path is a file or the latest markdown entry is a directory', t => {
  const root = fixture(t);
  const member = path.join(root, 'team', 'alex');
  fs.mkdirSync(member, { recursive: true });
  const journal = path.join(member, 'journal');
  fs.writeFileSync(journal, 'Not a directory');
  assert.strictEqual(getTeamMemberJournal(root, 'alex'), null);

  fs.unlinkSync(journal);
  fs.mkdirSync(journal);
  fs.writeFileSync(path.join(journal, '2024-06-11.md'), '**Task:** Older task\n');
  fs.mkdirSync(path.join(journal, '2024-06-12.md'));
  assert.strictEqual(getTeamMemberJournal(root, 'alex'), null);
});
