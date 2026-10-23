'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getTeamActivity } = require('../lib/todo-fallback');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-team-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function journal(root, member, filename, content) {
  const directory = path.join(root, 'team', member, 'journal');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, filename);
  fs.writeFileSync(file, content);
  return file;
}

test('returns each member latest markdown journal, newest activity first', (t) => {
  const root = workspace(t);
  journal(root, 'alice', '2024-01-01.md', '**Task:** superseded\n');
  const aliceRaw = '**Task:**   fix parser  \n**Delivered:**   tests  \n**Pattern:**   small changes  \n**Learned:**   check inputs  \n';
  const aliceFile = journal(root, 'alice', '2024-02-03.md', aliceRaw);
  journal(root, 'alice', '2099-12-31.txt', '**Task:** not markdown\n');
  const bobRaw = '**Task:** write docs\n';
  const bobFile = journal(root, 'bob', '2024-03-01.md', bobRaw);

  assert.deepStrictEqual(getTeamActivity(root), [
    { member: 'bob', date: '2024-03-01', file: bobFile,
      task: 'write docs', delivered: null, pattern: null, learned: null, raw: bobRaw },
    { member: 'alice', date: '2024-02-03', file: aliceFile,
      task: 'fix parser', delivered: 'tests', pattern: 'small changes',
      learned: 'check inputs', raw: aliceRaw },
  ]);
});

test('ignores hidden members and non-directories while preserving journals without fields', (t) => {
  const root = workspace(t);
  journal(root, '_template', '2024-04-01.md', '**Task:** template\n');
  journal(root, '.hidden', '2024-04-01.md', '**Task:** hidden\n');
  fs.writeFileSync(path.join(root, 'team', 'roster.md'), 'not a member');
  const raw = '# Notes\nNo structured activity fields.\n';
  const file = journal(root, 'carol', '2024-01-15.md', raw);

  assert.deepStrictEqual(getTeamActivity(root), [
    { member: 'carol', date: '2024-01-15', file,
      task: null, delivered: null, pattern: null, learned: null, raw },
  ]);
});

test('returns empty activity for missing, empty, and unreadable journals', (t) => {
  const root = workspace(t);
  assert.deepStrictEqual(getTeamActivity(root), []);
  fs.mkdirSync(path.join(root, 'team'));
  assert.deepStrictEqual(getTeamActivity(root), []);
  fs.mkdirSync(path.join(root, 'team', 'missing-journal'));
  fs.mkdirSync(path.join(root, 'team', 'empty-journal', 'journal'), { recursive: true });
  journal(root, 'text-only', '2024-01-01.txt', 'not markdown');
  fs.mkdirSync(path.join(root, 'team', 'unreadable', 'journal', '2024-01-01.md'), { recursive: true });
  fs.mkdirSync(path.join(root, 'team', 'invalid-journal'));
  fs.writeFileSync(path.join(root, 'team', 'invalid-journal', 'journal'), 'not a directory');

  assert.deepStrictEqual(getTeamActivity(root), []);
});
