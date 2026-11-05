'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planMemberUpLaunch, installMemberUpLaunch, resumeMemberUpLaunch } = require('../lib/member-up-launch');

test('launch plan names a project-specific service with crash restart and separate logs', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-launch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'project & one');
  fs.mkdirSync(root);
  const plan = planMemberUpLaunch({ root, cliPath: '/tmp/atris.js', stateHome: path.join(home, 'state'), homeDir: home, nodeBin: '/usr/bin/node', envPath: '/usr/bin', taskDb: '/tmp/tasks & more.db', max: 2, only: ['builder'] });
  assert.ok(plan.args.includes('--require-review'));
  assert.ok(plan.args.includes('--supervised'));
  assert.match(plan.contents, /project &amp; one/);
  assert.match(plan.contents, /tasks &amp; more\.db/);
  assert.match(plan.contents, /<key>SuccessfulExit<\/key><false\/>/);
  assert.notEqual(plan.stdout, plan.stderr);
  assert.ok(plan.stop.startsWith(plan.dir));
});

test('install does not replace a loaded service and reports bootstrap errors', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-launch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = planMemberUpLaunch({ root: home, cliPath: '/tmp/atris.js', stateHome: path.join(home, 'state'), homeDir: home });
  const loaded = installMemberUpLaunch(plan, { uid: 42, spawn: () => ({ status: 0 }) });
  assert.equal(loaded.ok, false);
  assert.equal(fs.existsSync(plan.file), false);
  let calls = 0;
  const failed = installMemberUpLaunch(plan, { uid: 42, spawn: () => (++calls === 1 ? { status: 113, stderr: 'Could not find service' } : { status: 1, stderr: 'launch refused' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /launch refused/);
  assert.equal(fs.existsSync(plan.file), true);
  assert.equal(fs.existsSync(plan.stop), true);
});


test('resume preserves the stop marker when launchd refuses to start', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-launch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = planMemberUpLaunch({ root: home, cliPath: '/tmp/atris.js', stateHome: path.join(home, 'state'), homeDir: home });
  fs.mkdirSync(plan.dir, { recursive: true });
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.contents);
  fs.writeFileSync(plan.stop, 'stopped');
  const out = resumeMemberUpLaunch(plan, { uid: 42, spawn: () => ({ status: 1, stderr: 'refused' }) });
  assert.equal(out.ok, false);
  assert.equal(fs.existsSync(plan.stop), true);
  assert.match(out.error, /refused/);
});

test('install does not treat an unreadable launchd domain as an absent service', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-launch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = planMemberUpLaunch({ root: home, cliPath: '/tmp/atris.js', stateHome: path.join(home, 'state'), homeDir: home });
  const out = installMemberUpLaunch(plan, { uid: 42, spawn: () => ({ status: 1, stderr: 'operation not permitted' }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /operation not permitted/);
  assert.equal(fs.existsSync(plan.file), false);
});

test('resuming an already-running supervisor does not restart it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-launch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = planMemberUpLaunch({ root: home, cliPath: '/tmp/atris.js', stateHome: path.join(home, 'state'), homeDir: home });
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.contents);
  let calls = 0;
  const out = resumeMemberUpLaunch(plan, { uid: 42, spawn: () => { calls += 1; return { status: 0, stdout: `pid = ${process.pid}` }; } });
  assert.equal(out.ok, true);
  assert.equal(out.already_running, true);
  assert.equal(calls, 1);
});

test('a recycled PID belonging to another process does not block a supervisor', async (t) => {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-up-recycled-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# isolated\n');
  fs.mkdirSync(home);
  const pidfile = path.join(root, '.atris', 'state', 'member-up.json');
  fs.mkdirSync(path.dirname(pidfile), { recursive: true });
  fs.writeFileSync(pidfile, JSON.stringify({ pid: process.pid, start_identity: 'a different process start' }));
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const child = spawn(process.execPath, [cli, 'member', 'up'], {
    cwd: root, env: { ...process.env, HOME: home, ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK: '1' }, stdio: 'ignore',
  });
  t.after(() => { try { child.kill('SIGTERM'); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  let actual;
  for (let i = 0; i < 50; i++) {
    try { actual = JSON.parse(fs.readFileSync(pidfile, 'utf8')); if (actual.pid === child.pid) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(actual?.pid, child.pid, 'the new supervisor replaces the stale PID record');
  assert.ok(actual.start_identity);
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
});


test('process identity is stable across caller timezones', () => {
  const { processStartIdentity } = require('../lib/member-up-launch');
  const before = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const a = processStartIdentity(process.pid);
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(processStartIdentity(process.pid), a);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('sleep reports and logs an unverifiable legacy supervisor instead of signalling it', (t) => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-up-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# isolated\n');
  fs.mkdirSync(home);
  const pidfile = path.join(root, '.atris', 'state', 'member-up.json');
  fs.mkdirSync(path.dirname(pidfile), { recursive: true });
  fs.writeFileSync(pidfile, JSON.stringify({ pid: process.pid }));
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const out = spawnSync(process.execPath, [cli, 'member', 'sleep', '--all', '--json'], {
    cwd: root, env: { ...process.env, HOME: home, ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK: '1' }, encoding: 'utf8',
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /cannot verify supervisor pid/);
  const plan = planMemberUpLaunch({ root, cliPath: cli, stateHome: path.join(home, '.atris'), homeDir: home });
  assert.match(fs.readFileSync(plan.stderr, 'utf8'), /cannot verify supervisor pid/);
});
