'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/atris.js');
const doctor = require('../lib/worktree-doctor');
const core = require('../lib/worktree-core');

test('doctor counts the registered copies shown by status', (t) => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'doctor-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'project');
  fs.mkdirSync(repo);
  function git(args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'file'), 'test\n');
  git(['add', 'file']);
  git(['commit', '-qm', 'initial']);
  const copies = [path.join(dir, '.agent-worktrees', 'project', 'one'), path.join(dir, 'elsewhere', 'two')];
  for (const [i, copy] of copies.entries()) {
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    git(['worktree', 'add', '-q', '-b', `copy-${i}`, copy]);
  }
  fs.mkdirSync(path.join(repo, '.agent-worktrees'));
  const run = (args) => spawnSync(process.execPath, [cli, 'worktree', ...args], { cwd: repo, encoding: 'utf8' });
  const status = run(['status']);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  for (const copy of copies) assert.ok(status.stdout.includes(copy), status.stdout);
  const report = doctor.doctorWorkspace({ workspace: core.defaultSweepWorkspace(repo), repoRoot: repo, active: [], measure: false });
  assert.equal(report.totals.copies, copies.length, 'doctor must count every non-primary registered copy');
  assert.deepEqual(report.repos.flatMap((entry) => entry.copies.map((copy) => copy.path)).sort(), copies.sort());
  assert.ok(report.repos.flatMap((entry) => entry.copies).every((copy) => !copy.prune));
});
