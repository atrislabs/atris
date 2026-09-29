'use strict';

let test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.platform !== 'darwin' || !fs.existsSync('/usr/sbin/lsof') || !fs.existsSync('/usr/bin/pgrep')) test = test.skip;

function sleeper(options) {
  const child = spawn('/bin/sleep', ['30'], options);
  child.unref();
  return child;
}

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sandbox-pids-')));
  const worktree = path.join(base, 'worktree');
  const leaseFile = path.join(base, 'sandbox-process.lease');
  fs.mkdirSync(path.join(worktree, 'nested'), { recursive: true });
  const leaseFd = fs.openSync(leaseFile, 'w', 0o600);
  const grouped = sleeper({ cwd: '/', detached: true, stdio: 'ignore' });
  const leased = sleeper({ cwd: '/', stdio: ['ignore', 'ignore', 'ignore', leaseFd] });
  fs.closeSync(leaseFd);
  const rooted = sleeper({ cwd: path.join(worktree, 'nested'), stdio: 'ignore' });
  const outsider = sleeper({ cwd: base, stdio: 'ignore' });
  const children = [grouped, leased, rooted, outsider];
  return {
    base,
    worktree,
    leaseFile,
    grouped,
    leased,
    rooted,
    outsider,
    cleanup() {
      for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function assertTracked(pids, setup) {
  assert.ok(pids.includes(setup.grouped.pid), 'process group member must be tracked');
  assert.ok(pids.includes(setup.leased.pid), 'lease holder must be tracked');
  assert.ok(pids.includes(setup.rooted.pid), 'process rooted in the worktree must be tracked');
  assert.ok(!pids.includes(setup.outsider.pid), 'process outside every boundary must not be tracked');
  assert.ok(!pids.includes(process.pid), 'the caller must never be tracked');
}

test('sandbox pid discovery finds the group, the lease holder, and worktree-rooted processes', async () => {
  const { trackedSandboxPids, trackedSandboxPidsSync } = require('../lib/sandbox-pids');
  const setup = fixture();
  try {
    const query = { pgid: setup.grouped.pid, leaseFile: setup.leaseFile, cwd: setup.worktree };
    assertTracked(await trackedSandboxPids(query), setup);
    assertTracked(trackedSandboxPidsSync(query), setup);
  } finally {
    setup.cleanup();
  }
});

test('sandbox pid discovery never reports the caller even when it runs inside the worktree', async () => {
  const { trackedSandboxPids, trackedSandboxPidsSync } = require('../lib/sandbox-pids');
  const setup = fixture();
  const previous = process.cwd();
  try {
    process.chdir(setup.worktree);
    const query = { pgid: setup.grouped.pid, leaseFile: setup.leaseFile, cwd: setup.worktree };
    const asyncPids = await trackedSandboxPids(query);
    const syncPids = trackedSandboxPidsSync(query);
    process.chdir(previous);
    assertTracked(asyncPids, setup);
    assertTracked(syncPids, setup);
    // only the four fixture sleepers may exist in these boundaries; a query
    // helper that leaked its own pid would show up as a fifth
    const known = new Set([setup.grouped.pid, setup.leased.pid, setup.rooted.pid]);
    assert.deepEqual(asyncPids.filter((pid) => !known.has(pid)), []);
    assert.deepEqual(syncPids.filter((pid) => !known.has(pid)), []);
  } finally {
    process.chdir(previous);
    setup.cleanup();
  }
});

test('sandbox pid discovery without a group or cwd still finds the lease holder', async () => {
  const { trackedSandboxPids, trackedSandboxPidsSync } = require('../lib/sandbox-pids');
  const setup = fixture();
  try {
    const query = { pgid: 0, leaseFile: setup.leaseFile, cwd: '' };
    for (const pids of [await trackedSandboxPids(query), trackedSandboxPidsSync(query)]) {
      assert.ok(pids.includes(setup.leased.pid));
      assert.ok(!pids.includes(setup.grouped.pid));
      assert.ok(!pids.includes(setup.rooted.pid));
    }
  } finally {
    setup.cleanup();
  }
});
