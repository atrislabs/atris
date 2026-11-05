'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactMissionLedger, compactRows } = require('../lib/mission-ledger-compact');
const { runMissionCli, runMissionGit } = require('./helpers/mission-json');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ledger-preserve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('row reduction keeps the latest state and the first display number', () => {
  const rows = [{ id: 'a', n: 7, status: 'planning' }, { id: 'b', status: 'ready' },
    { id: 'a', n: 99, status: 'complete' }, { cloud: true, text: 'receipt' }];
  assert.deepEqual(compactRows(rows), [{ id: 'a', n: 7, status: 'complete' },
    { id: 'b', status: 'ready' }, { cloud: true, text: 'receipt' }]);
});

test('direct and forced compaction preserve every byte of a ledger', (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'missions.jsonl');
  const before = `${JSON.stringify({ id: 'one', status: 'open' })}\nnot-json\n${JSON.stringify({ cloud: true, text: 'receipt' })}\n`;
  fs.writeFileSync(file, before);
  for (const options of [{}, { force: true, minBytes: 0 }]) {
    assert.deepEqual(compactMissionLedger(file, options), { compacted: false, reason: 'concurrent_writers_unfenced' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('real mission save retains a large append-only history', (t) => {
  const dir = workspace(t);
  runMissionGit(['init'], dir);
  runMissionGit(['config', 'user.email', 'test@example.com'], dir);
  runMissionGit(['config', 'user.name', 'Test User'], dir);
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  runMissionGit(['add', '.'], dir);
  runMissionGit(['commit', '-m', 'base'], dir);
  const state = path.join(dir, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const file = path.join(state, 'missions.jsonl');
  const oldRows = Array.from({ length: 70 }, (_, i) => JSON.stringify({ id: 'old-mission', status: 'complete', tick: i, padding: 'x'.repeat(4096) })).join('\n') + '\n';
  fs.writeFileSync(file, oldRows);
  const result = runMissionCli(['mission', 'start', '--no-verify', 'preserve a new mission', '--owner', 'mission-lead', '--json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const saved = JSON.parse(result.stdout).mission;
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(oldRows), 'all old snapshots must survive a save above the former compaction threshold');
  assert.ok(after.slice(oldRows.length).split('\n').filter(Boolean).map(JSON.parse).some(row => row.id === saved.id));
});
