'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTeamState } = require('../lib/zen');

const defaults = [
  'atris/', '.atris/', '.claude/', '.codex/', '.cursor/',
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
  '*.db', '*.db-wal', '*.db-shm', '*.sqlite', '*.sqlite3', '*.duckdb',
  '*.jsonl', '*.ndjson',
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-read-team-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.atris'));
  return {
    root,
    write(text) {
      fs.writeFileSync(path.join(root, '.atris', 'zen.json'), text);
    },
  };
}

test('readTeamState appends configured paths and patterns to the defaults', (t) => {
  const { root, write } = fixture(t);
  write(JSON.stringify({ team_state: ['notes/', 'custom.md', '*.cache'] }));
  assert.deepStrictEqual(readTeamState(root), [...defaults, 'notes/', 'custom.md', '*.cache']);
});

test('readTeamState trims strings, ignores invalid entries, and preserves order and duplicates', (t) => {
  const { root, write } = fixture(t);
  write(JSON.stringify({
    team_state: ['  notes/\t', '', ' \n\t', null, 42, false, {}, ['nested/'], 'notes/', ' atris/ '],
  }));
  assert.deepStrictEqual(readTeamState(root), [...defaults, 'notes/', 'notes/', 'atris/']);
});

test('readTeamState returns defaults for absent, empty, or invalid configuration', (t) => {
  const { root, write } = fixture(t);
  assert.deepStrictEqual(readTeamState(root), defaults);
  for (const text of [
    '', '{bad json', 'null', '{}',
    JSON.stringify({ team_state: [] }),
    JSON.stringify({ team_state: 'notes/' }),
    JSON.stringify({ team_state: { path: 'notes/' } }),
    JSON.stringify({ team_state: null }),
  ]) {
    write(text);
    assert.deepStrictEqual(readTeamState(root), defaults, `configuration: ${text}`);
  }
});

test('readTeamState returns independent arrays without leaking custom paths between roots', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  first.write(JSON.stringify({ team_state: ['private-notes/'] }));
  const result = readTeamState(first.root);
  result[0] = 'changed/';
  result.push('injected/');
  assert.deepStrictEqual(readTeamState(first.root), [...defaults, 'private-notes/']);
  assert.deepStrictEqual(readTeamState(second.root), defaults);
});
