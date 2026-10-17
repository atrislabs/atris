'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repo = path.resolve(__dirname, '..');
const skill = path.join('atris', 'SKILL.md');
const packagedSkill = fs.readFileSync(path.join(repo, 'atris', 'skills', skill));
const hook = path.join('autopilot', 'hooks', 'stop-hook.sh');
const customHook = '#!/bin/sh\n# owned custom hook, preserve it\n';
const globalDirs = ['.claude', '.codex'];
const syncProbe = `
  const { syncSkills } = require(process.argv[1]);
  process.stdout.write(JSON.stringify({
    first: syncSkills({ silent: true }),
    second: syncSkills({ silent: true }),
  }));
`;

function fixture(t, { project = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const fence = path.join(root, 'fence');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  for (const base of [home, fence]) {
    for (const dir of globalDirs) {
      const skills = path.join(base, dir, 'skills');
      fs.mkdirSync(path.dirname(path.join(skills, skill)), { recursive: true });
      fs.writeFileSync(path.join(skills, skill), 'stale owned skill\n');
      fs.mkdirSync(path.dirname(path.join(skills, hook)), { recursive: true });
      fs.writeFileSync(path.join(skills, hook), customHook, { mode: 0o700 });
    }
    fs.writeFileSync(path.join(base, 'sentinel'), 'owned home marker\n');
  }
  if (project) fs.mkdirSync(path.join(cwd, 'atris'));
  const env = {
    ...scrubAgentEnv(),
    HOME: home,
    USERPROFILE: home,
    ATRIS_TEST_PROTECTED_HOME: home,
    ATRIS_TEST_STATE_DIR: fence,
    ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
    ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db'),
    ATRIS_RSI_STATE: path.join(root, 'rsi'),
    ATRIS_SKIP_UPDATE_CHECK: '1',
  };
  delete env.ATRIS_TEST_REAL_HOME;
  return { root, home, fence, cwd, env };
}

// Reading the owned tree can change access times; pin content, permissions,
// modification times and change times, which synchronization must not change.
function snapshot(root) {
  const rows = [];
  function walk(file, relative) {
    const stat = fs.lstatSync(file, { bigint: true });
    const row = { path: relative, mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
    if (stat.isDirectory()) {
      rows.push({ ...row, type: 'directory' });
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name));
    } else if (stat.isSymbolicLink()) {
      rows.push({ ...row, type: 'link', target: fs.readlinkSync(file) });
    } else {
      rows.push({ ...row, type: 'file', bytes: fs.readFileSync(file).toString('hex') });
    }
  }
  walk(root, '.');
  return rows;
}

function run(f, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function assertGlobalSkills(home) {
  for (const dir of globalDirs) {
    const skills = path.join(home, dir, 'skills');
    assert.deepEqual(fs.readFileSync(path.join(skills, skill)), packagedSkill);
    assert.equal(fs.readFileSync(path.join(skills, hook), 'utf8'), customHook);
  }
}

function assertProjectSkills(cwd) {
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'atris', 'skills', skill)), packagedSkill);
  const linkedSkill = path.join(cwd, '.claude', 'skills', 'atris');
  assert.deepEqual(fs.readFileSync(path.join(linkedSkill, 'SKILL.md')), packagedSkill);
  if (fs.lstatSync(linkedSkill).isSymbolicLink()) {
    assert.equal(fs.readlinkSync(linkedSkill), path.join('..', '..', 'atris', 'skills', 'atris'));
  }
}

test('init keeps protected global skills inside the test-state home', (t) => {
  const f = fixture(t, { project: false });
  const before = snapshot(f.home);
  const result = run(f, [path.join(repo, 'bin', 'atris.js'), 'init', '--minimal', '--yes', '--no-commit']);
  assert.match(result.stdout, /atris initialized\./);
  assert.ok(fs.existsSync(path.join(f.cwd, 'atris', 'atris.md')));
  assert.deepEqual(snapshot(f.home), before, 'protected home bytes, modes and times changed');
  assertGlobalSkills(f.fence);
});

test('ordinary skill sync keeps the normal global and project destinations', (t) => {
  const f = fixture(t);
  delete f.env.NODE_TEST_CONTEXT;
  delete f.env.ATRIS_TEST_STATE_DIR;
  const beforeFence = snapshot(f.fence);
  const counts = JSON.parse(run(f, ['-e', syncProbe, path.join(repo, 'commands', 'sync.js')]).stdout);
  assert.ok(counts.first > 0);
  assert.equal(counts.second, 0);
  assertGlobalSkills(f.home);
  assertProjectSkills(f.cwd);
  assert.deepEqual(snapshot(f.fence), beforeFence);
});

test('an explicit temporary HOME wins over a different test-state home', (t) => {
  const f = fixture(t);
  delete f.env.ATRIS_TEST_PROTECTED_HOME;
  const beforeFence = snapshot(f.fence);
  const counts = JSON.parse(run(f, ['-e', syncProbe, path.join(repo, 'commands', 'sync.js')]).stdout);
  assert.ok(counts.first > 0);
  assert.equal(counts.second, 0);
  assertGlobalSkills(f.home);
  assertProjectSkills(f.cwd);
  assert.deepEqual(snapshot(f.fence), beforeFence);
});

test('the real-home opt-out still permits deliberate skill synchronization', (t) => {
  const f = fixture(t);
  f.env.ATRIS_TEST_REAL_HOME = '1';
  const beforeFence = snapshot(f.fence);
  const counts = JSON.parse(run(f, ['-e', syncProbe, path.join(repo, 'commands', 'sync.js')]).stdout);
  assert.ok(counts.first > 0);
  assert.equal(counts.second, 0);
  assertGlobalSkills(f.home);
  assertProjectSkills(f.cwd);
  assert.deepEqual(snapshot(f.fence), beforeFence);
});
