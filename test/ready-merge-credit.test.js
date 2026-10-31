'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');
const { loadSeason } = require('../lib/gm-season');
const { shipMergeRecord, landedMergeFlags } = require('../lib/fleet');

const COMMIT = '93b6d4bcf66276bbd6a53aebe72ab48bf9a7b136';
const URL = 'https://github.com/o/r/pull/4676';
const MERGED_AT = '2026-10-31T02:10:45Z';

test('a flight reads the merge that ship printed and hands it to task ready', () => {
  const shipped = `merge: merged\nmerge: record {"merge_commit":"${COMMIT}","number":4676,"url":"${URL}","merged_at":"${MERGED_AT}"}\ndone: worktree shipped\n`;
  const merge = shipMergeRecord(shipped);
  assert.deepEqual(merge, { merge_commit: COMMIT, number: 4676, url: URL, merged_at: MERGED_AT });
  assert.deepEqual(landedMergeFlags(merge), ['--merge-commit', COMMIT, '--self-landed', '--pr-number', '4676', '--pr-url', URL, '--merged-at', MERGED_AT]);
  assert.equal(shipMergeRecord('merge: merged\ndone: worktree shipped\n'), null);
  assert.equal(shipMergeRecord('merge: record {broken\n'), null);
  assert.deepEqual(landedMergeFlags(null), []);
});

test('a self-landed fix counts as landed without crediting a person, and prose alone still does not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-credit-'));
  const dbPath = path.join(dir, 'tasks.db');
  const db = tasks.open(dbPath);
  t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const claimed = (title) => {
    const { id } = tasks.addTask(db, { title, workspaceRoot: dir });
    assert.equal(tasks.claimTask(db, { id, claimedBy: 'fleet-codex' }).claimed, true);
    return id;
  };
  const merged = claimed('merged fix'), prose = claimed('prose only'), junk = claimed('bad commit');
  const ready = (id, merge) => tasks.readyTask(db, { id, actor: 'fleet-codex', proof: 'shipped through the ship gate', merge }).ready;
  assert.equal(ready(merged, { merge_commit: COMMIT.toUpperCase(), number: '4676', url: URL, merged_at: MERGED_AT, self_landed: true }), true);
  assert.equal(ready(prose), true);
  assert.equal(ready(junk, { merge_commit: 'not-a-commit', self_landed: true }), true);
  const payload = (id) => JSON.parse(db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'proof_ready'").get(id).payload);
  assert.equal(payload(merged).landing.merge_commit, COMMIT);
  assert.deepEqual(payload(merged).pull_request, { state: 'merged', merge_commit: COMMIT, number: 4676, url: URL, merged_at: MERGED_AT });
  assert.equal(payload(merged).self_landed, true);
  assert.equal(tasks.getTask(db, merged).metadata.merge_commit, COMMIT);
  for (const id of [prose, junk]) {
    assert.equal(payload(id).pull_request, undefined);
    assert.equal(payload(id).self_landed, undefined);
  }
  const season = loadSeason(dir, { dbPath, now: Date.now() + 1000, lastSeen: null });
  assert.equal(season.error, undefined);
  const landed = season.outcomes.filter(o => o.kind === 'landed');
  assert.deepEqual(landed.map(o => [o.task_id, o.member, o.landed_by]), [[merged, 'fleet-codex', 'autoland']]);
});
