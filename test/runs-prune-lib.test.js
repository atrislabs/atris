'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pruneRuns, runsPruneLines, formatBytes } = require('../lib/runs-prune');

const nowMs = Date.UTC(2026, 9, 23);
const day = 86400000;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-prune-lib-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relative, content, ageDays = 30) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const time = new Date(nowMs - ageDays * day);
      fs.utimesSync(file, time, time);
      return file;
    },
  };
}

test('preview preserves referenced siblings, recent files, newest files, and archives', (t) => {
  const { root, write } = fixture(t);
  const old = write('atris/runs/stale/log.txt', 'old');
  write('atris/runs/proof/receipt.json', '{}');
  write('atris/runs/proof/output.txt', 'proof');
  write('atris/runs/recent.txt', 'recent', 2);
  write('atris/runs/newest.txt', 'newest', 1);
  const archived = write('atris/runs/_archive/previous.json', '{}');
  write('.atris/state/task.json', JSON.stringify({ proof: 'atris/runs/proof/receipt.json' }));

  const result = pruneRuns(root, { nowMs, keepDays: 14, keepNewest: 1 });

  assert.strictEqual(result.action, 'runs_prune_preview');
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.total_files, 5);
  assert.strictEqual(result.referenced_files, 2);
  assert.strictEqual(result.recent_files, 2);
  assert.strictEqual(result.newest_files, 1);
  assert.deepStrictEqual(result.candidates, [
    { path: 'atris/runs/stale/log.txt', bytes: 3, age_days: 30, kind: 'txt' },
  ]);
  assert.strictEqual(result.prune_bytes, 3);
  assert.strictEqual(result.deleted_count, 0);
  assert.strictEqual(result.manifest_path, null);
  assert.strictEqual(fs.readFileSync(old, 'utf8'), 'old');
  assert.strictEqual(fs.existsSync(archived), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/runs/_archive/prune.json')), false);
});

test('apply refuses to delete candidates and preserves the original receipt', (t) => {
  const { root, write } = fixture(t);
  const old = write('atris/runs/old/nested/receipt.json', '{"proof":"full content"}');
  const preview = pruneRuns(root, { nowMs, keepDays: 0, keepNewest: 0 });
  assert.strictEqual(preview.prune_count, 1);
  assert.throws(() => pruneRuns(root, { nowMs, apply: true, keepDays: 0, keepNewest: 0 }), /receipt deletion is unavailable/);
  assert.strictEqual(fs.readFileSync(old, 'utf8'), '{"proof":"full content"}');
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/runs/_archive')), false);
  assert.strictEqual(formatBytes(1023), '1023 B');
  assert.strictEqual(formatBytes(1024), '1.0 KB');
  assert.strictEqual(formatBytes(1048576), '1.0 MB');
});

test('apply refuses to delete receipts if a reference file cannot be read', (t) => {
  const { root, write } = fixture(t);
  const receipt = write('atris/runs/needed.json', '{}');
  const state = write('.atris/state/missions.jsonl', JSON.stringify({ receipt_path: 'atris/runs/needed.json' }));
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (file === state) throw Object.assign(new Error('simulated read failure'), { code: 'EIO' });
    return read.call(this, file, ...args);
  };
  try {
    assert.throws(() => pruneRuns(root, { nowMs, apply: true, keepDays: 0, keepNewest: 0 }), /cannot safely scan run references/);
  } finally {
    fs.readFileSync = read;
  }
  assert.strictEqual(fs.existsSync(receipt), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/runs/_archive')), false);
});

test('apply refuses to delete receipts if a state subdirectory cannot be read', (t) => {
  const { root, write } = fixture(t);
  const receipt = write('atris/runs/needed.json', '{}');
  const state = write('.atris/state/nested/task.json', JSON.stringify({ proof: 'atris/runs/needed.json' }));
  const blocked = path.dirname(state);
  const read = fs.readdirSync;
  fs.readdirSync = function(dir, ...args) {
    if (dir === blocked) throw Object.assign(new Error('simulated directory failure'), { code: 'EACCES' });
    return read.call(this, dir, ...args);
  };
  try {
    assert.throws(() => pruneRuns(root, { nowMs, apply: true, keepDays: 0, keepNewest: 0 }), /cannot safely scan run references/);
  } finally {
    fs.readdirSync = read;
  }
  assert.strictEqual(fs.existsSync(receipt), true);
});

test('mission prune CLI reports reference read errors without deleting anything', (t) => {
  const { root, write } = fixture(t);
  const receipt = write('atris/runs/needed.json', '{}');
  const state = write('.atris/state/missions.jsonl', JSON.stringify({ receipt_path: 'atris/runs/needed.json' }));
  const preload = path.join(root, 'fail-read.cjs');
  fs.writeFileSync(preload, `const fs = require('fs'); const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).endsWith('/.atris/state/missions.jsonl')) throw Object.assign(new Error('simulated read failure'), { code: 'EIO' }); return read.call(this, file, ...args); };`);
  const result = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '../bin/atris.js'), 'mission', 'prune-runs', '--apply', '--days', '0', '--keep-newest', '0', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PRUNE_TEST_BLOCKED_FILE: state },
  });
  assert.strictEqual(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /cannot safely scan run references/);
  assert.strictEqual(fs.existsSync(receipt), true);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris/runs/_archive')), false);
});

test('apply refuses to delete receipts when state includes symlinks', (t) => {
  const { root, write } = fixture(t);
  const receipt = write('atris/runs/needed.json', '{}');
  const source = write('state-source.json', JSON.stringify({ proof: 'atris/runs/needed.json' }));
  fs.mkdirSync(path.join(root, '.atris/state'), { recursive: true });
  fs.symlinkSync(source, path.join(root, '.atris/state/linked.json'));
  assert.throws(() => pruneRuns(root, { nowMs, apply: true, keepDays: 0, keepNewest: 0 }), /symbolic link in state/);
  assert.strictEqual(fs.existsSync(receipt), true);
});

test('apply refuses a dangling state-root symlink', (t) => {
  const { root, write } = fixture(t);
  const receipt = write('atris/runs/needed.json', '{}');
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, '.atris/state'));
  assert.throws(() => pruneRuns(root, { nowMs, apply: true, keepDays: 0, keepNewest: 0 }), /symbolic link in state/);
  assert.strictEqual(fs.existsSync(receipt), true);
});

test('apply refuses symlinked state parent, even when dangling', (t) => {
  for (const dangling of [true, false]) {
    const { root, write } = fixture(t);
    const receipt = write('atris/runs/needed.json', '{}');
    const target = path.join(root, 'state-parent');
    if (!dangling) fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, '.atris'));
    assert.throws(() => pruneRuns(root, { nowMs, apply: true, keepDays: 0, keepNewest: 0 }), /symbolic link in state/);
    assert.strictEqual(fs.existsSync(receipt), true);
  }
});
