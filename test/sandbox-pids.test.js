'use strict';

let test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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

// Some agent sandboxes deny pgrep the process list. The group check needs a
// working pgrep, so it runs only when pgrep can see the fixture's own group;
// the lease and worktree checks run everywhere.
function pgrepSeesGroup(pgid) {
  const probe = spawnSync('/usr/bin/pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
  return probe.status === 0 && String(probe.stdout).split(/\s+/).includes(String(pgid));
}

function assertTracked(pids, setup) {
  if (pgrepSeesGroup(setup.grouped.pid)) {
    assert.ok(pids.includes(setup.grouped.pid), 'process group member must be tracked');
  }
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
    // a pgrep that cannot read the process list finds nothing, so the helper
    // pid check below still holds without it
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

test('a scan that fails is not read as "found nothing"', async () => {
  const { runScan } = require('../lib/sandbox-pids');
  const killed = await runScan('/bin/sh', ['-c', 'kill -KILL $$']);
  assert.equal(killed.ok, false, 'a scan killed by a signal must count as failed');
  assert.equal((await runScan('/bin/sh', ['-c', 'exit 2'])).ok, false, 'a scan error status must count as failed');
  assert.equal((await runScan('/nonexistent/atris-scan', [])).ok, false, 'a scan that cannot start must count as failed');
  const empty = await runScan('/bin/sh', ['-c', 'exit 1']);
  assert.deepEqual(empty, { ok: true, stdout: '' }, 'status 1 is pgrep and lsof for no match');
  const found = await runScan('/bin/sh', ['-c', 'echo 4242']);
  assert.deepEqual(found, { ok: true, stdout: '4242\n' });
});

test('failed parallel scans fall back to the one-by-one sweep and still find the lease holder', async () => {
  const { trackedSandboxPids } = require('../lib/sandbox-pids');
  const setup = fixture();
  try {
    const query = { pgid: setup.grouped.pid, leaseFile: setup.leaseFile, cwd: setup.worktree };
    const killedScan = () => new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', 'kill -KILL $$'], { stdio: 'ignore' });
      child.once('close', () => resolve({ ok: false, stdout: '' }));
    });
    assertTracked(await trackedSandboxPids(query, { scan: killedScan }), setup);
  } finally {
    setup.cleanup();
  }
});

test('running out of file descriptors does not crash the sweep', () => {
  const script = [
    "const fs = require('node:fs');",
    `const { trackedSandboxPids } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'sandbox-pids.js'))});`,
    'const held = [];',
    "try { for (;;) held.push(fs.openSync('/dev/null', 'r')); } catch {}",
    "trackedSandboxPids({ pgid: process.pid, leaseFile: '/nonexistent/atris-lease', cwd: '/nonexistent/atris-worktree' })",
    "  .then((pids) => { for (const fd of held) fs.closeSync(fd); process.stdout.write('swept ' + Array.isArray(pids) + '\\n'); });",
  ].join('\n');
  const result = spawnSync('/bin/sh', ['-c', 'ulimit -n 64 && exec "$0" -e "$1"', process.execPath, script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'swept true');
});
