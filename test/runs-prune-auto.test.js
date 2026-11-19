'use strict';

// Run records piled up with nothing pruning them: 5,650 files and 242 MB in
// one project by 2026-11-17, 3,720 of them older than 14 days. The hourly
// tick now prunes once a day. It keeps the newest 200, the last 14 days,
// every record a job names, the newest record of each kind and every file
// git tracks, and it leaves a run folder git does not ignore alone.
//
// Temp git repos only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autoPruneRuns, recordKind } = require('../lib/runs-prune');

const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);
const DAY = 86400000;

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function repo(t, { ignoreRuns = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-auto-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'master'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
  fs.writeFileSync(path.join(root, '.gitignore'), ignoreRuns ? '.atris/\natris/runs/\n' : '.atris/\n');
  fs.mkdirSync(path.join(root, 'atris', 'runs'), { recursive: true });
  return root;
}

function run(root, rel, ageDays) {
  const file = path.join(root, 'atris', 'runs', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"ok":true}\n');
  const at = (NOW - ageDays * DAY) / 1000;
  fs.utimesSync(file, at, at);
  return file;
}

function ticks(root, count, startAge) {
  const files = [];
  for (let i = 0; i < count; i++) {
    const age = startAge + i;
    const stamp = new Date(NOW - age * DAY).toISOString().replace(/[:.]/g, '-');
    files.push(run(root, `autoland-tick-${stamp}.json`, age));
  }
  return files;
}

test('the kind of a record is its folder and its name without the date', () => {
  assert.equal(recordKind('atris/runs/autoland-tick-2026-11-17T08-14-04-995Z.json'), 'atris/runs/autoland-tick');
  assert.equal(recordKind('atris/runs/m-1/tick-0001.json'), 'atris/runs/m-1/tick');
});

test('old untracked records go, and recent, newest-of-kind, named and tracked ones stay', (t) => {
  const root = repo(t);
  // 210 ticks, 10 to 219 days old. The newest 200 overall stay; the other
  // records below are older than every tick.
  const all = ticks(root, 210, 10);
  // A lone old record of another kind: the newest of its kind, so it stays.
  const lone = run(root, 'mission-room-2026-09-01.json', 377);
  // Two old records of a third kind: the older goes, the newer stays.
  const pairOld = run(root, 'review-2026-09-01.json', 380);
  const pairNew = run(root, 'review-2026-09-02.json', 379);
  // An old record a job names in .atris/state stays.
  const named = run(root, 'proof-2026-08-01/answer.json', 400);
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ proof: 'atris/runs/proof-2026-08-01/answer.json' }));
  // An old record git tracks (force-added) stays.
  const tracked = run(root, 'kept-2026-08-01.json', 401);
  run(root, 'kept-2026-08-02.json', 399);
  git(['add', '-f', 'atris/runs/kept-2026-08-01.json'], root);
  git(['commit', '-qm', 'keep one run'], root);
  fs.utimesSync(tracked, (NOW - 401 * DAY) / 1000, (NOW - 401 * DAY) / 1000);

  const preview = autoPruneRuns(root, { nowMs: NOW });
  assert.equal(preview.applied, false);
  assert.ok(preview.prune_count > 0);
  for (const file of all) assert.ok(fs.existsSync(file), 'a preview deletes nothing');

  const out = autoPruneRuns(root, { apply: true, nowMs: NOW });
  assert.equal(out.applied, true);
  assert.equal(out.deleted_count, out.prune_count);
  assert.equal(out.errors, 0);
  const kept = all.filter((f) => fs.existsSync(f));
  assert.equal(kept.length, 200, 'the newest 200 ticks stay');
  assert.ok(fs.existsSync(all[0]), 'the newest tick stays');
  assert.equal(fs.existsSync(all[all.length - 1]), false, 'the oldest tick goes');
  assert.ok(fs.existsSync(lone), 'the newest of its kind stays');
  assert.ok(fs.existsSync(pairNew));
  assert.equal(fs.existsSync(pairOld), false);
  assert.ok(fs.existsSync(named), 'a record a job names stays');
  assert.ok(fs.existsSync(tracked), 'a tracked record stays');
  assert.ok(out.manifest_path, 'a manifest of what went is kept');
});

test('a run folder git does not ignore is left alone', (t) => {
  const root = repo(t, { ignoreRuns: false });
  const files = ticks(root, 250, 30);
  const out = autoPruneRuns(root, { apply: true, nowMs: NOW });
  assert.equal(out.skipped, 'kept_in_git');
  for (const file of files) assert.ok(fs.existsSync(file));
});

test('a project with no run folder is skipped', (t) => {
  const root = repo(t);
  fs.rmSync(path.join(root, 'atris', 'runs'), { recursive: true });
  assert.equal(autoPruneRuns(root, { apply: true, nowMs: NOW }).skipped, 'no_runs_folder');
});
