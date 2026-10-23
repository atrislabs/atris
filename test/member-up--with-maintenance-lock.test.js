'use strict';

// withMaintenanceLock lets one pass at a time read GitHub's merge line for a
// project, across every window of that project. It skips a pass that ran less
// than five minutes ago, leaves a live holder alone, takes over a lock whose
// owner is gone, and always lets go of the lock when the pass throws.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { withMaintenanceLock } = require('../lib/member-up');

// Keep the run independent of the machine and the caller's environment.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'member-up-lock-'));
process.env.HOME = path.join(ROOT, 'home');
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
fs.mkdirSync(process.env.HOME);

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const MINUTE = 60 * 1000;
const STATE_FILE = 'test-pass.json';

let counter = 0;
function freshDir(label) {
  counter += 1;
  const dir = path.join(ROOT, `${label}-${counter}`);
  fs.mkdirSync(dir);
  return dir;
}

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, `git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

// A git repo with one commit, so linked work folders can be added to it.
function makeRepo(label) {
  const dir = freshDir(label);
  git(dir, ['init', '-q']);
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function stateDir(repo) {
  return path.join(repo, '.atris', 'state');
}

function lockPath(repo) {
  return path.join(stateDir(repo), 'member-up-maintenance.lock');
}

function writeLock(repo, body, mtime = NOW) {
  fs.mkdirSync(stateDir(repo), { recursive: true });
  fs.writeFileSync(lockPath(repo), body);
  const when = new Date(mtime);
  fs.utimesSync(lockPath(repo), when, when);
}

function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(repo), STATE_FILE), 'utf8'));
}

test('runs the callback with a saved timestamp, returns its value, and releases the lock', () => {
  const repo = makeRepo('normal');
  let seen = null;
  const result = withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, (state) => {
    seen = state;
    return { ran: true };
  });

  assert.deepStrictEqual(result, { ran: true });
  assert.strictEqual(seen.checked_at, NOW);
  assert.strictEqual(readState(repo).checked_at, NOW);
  assert.strictEqual(fs.existsSync(lockPath(repo)), false);
});

test('skips the pass until five minutes after the last one', () => {
  const repo = makeRepo('throttle');
  const first = withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, () => 'first');
  assert.strictEqual(first, 'first');

  let calls = 0;
  const early = withMaintenanceLock({ cwd: repo, now: NOW + 4 * MINUTE, stateFile: STATE_FILE }, () => {
    calls += 1;
    return 'early';
  });
  assert.deepStrictEqual(early, { results: [] });
  assert.strictEqual(calls, 0);

  const onTime = withMaintenanceLock({ cwd: repo, now: NOW + 5 * MINUTE, stateFile: STATE_FILE }, () => {
    calls += 1;
    return 'on-time';
  });
  assert.strictEqual(onTime, 'on-time');
  assert.strictEqual(calls, 1);
  assert.strictEqual(readState(repo).checked_at, NOW + 5 * MINUTE);
});

test('fields saved in the state file are there on the next pass', () => {
  const repo = makeRepo('save');
  withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, (state, save) => {
    state.waiting_since = NOW;
    save();
  });

  let sawWaiting = null;
  withMaintenanceLock({ cwd: repo, now: NOW + 6 * MINUTE, stateFile: STATE_FILE }, (state) => {
    sawWaiting = state.waiting_since;
  });
  assert.strictEqual(sawWaiting, NOW);
  assert.strictEqual(readState(repo).waiting_since, NOW);
});

test('a live lock holder blocks the pass and keeps its lock', () => {
  const repo = makeRepo('live-holder');
  writeLock(repo, JSON.stringify({ pid: process.pid, at: NOW }));

  let calls = 0;
  const result = withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, () => {
    calls += 1;
  });
  assert.deepStrictEqual(result, { results: [] });
  assert.strictEqual(calls, 0);
  assert.strictEqual(fs.existsSync(lockPath(repo)), true);
});

test('an unreadable lock holds while fresh and is taken over once stale', () => {
  const repo = makeRepo('unknown-owner');
  writeLock(repo, 'not json', NOW - 30 * 1000);

  let calls = 0;
  const held = withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, () => {
    calls += 1;
  });
  assert.deepStrictEqual(held, { results: [] });
  assert.strictEqual(calls, 0);

  writeLock(repo, 'not json', NOW - 3 * MINUTE);
  const taken = withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, () => {
    calls += 1;
    return 'taken';
  });
  assert.strictEqual(taken, 'taken');
  assert.strictEqual(calls, 1);
  assert.strictEqual(fs.existsSync(lockPath(repo)), false);
});

test('a lock whose owner process is gone is taken over', () => {
  const repo = makeRepo('dead-owner');
  // A child that has already exited: its pid is no longer a live process.
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.strictEqual(typeof child.pid, 'number');
  writeLock(repo, JSON.stringify({ pid: child.pid, at: NOW }));

  const result = withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, () => 'took-over');
  assert.strictEqual(result, 'took-over');
  assert.strictEqual(fs.existsSync(lockPath(repo)), false);
});

test('an error inside the callback still releases the lock', () => {
  const repo = makeRepo('throws');
  assert.throws(
    () => withMaintenanceLock({ cwd: repo, now: NOW, stateFile: STATE_FILE }, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.strictEqual(fs.existsSync(lockPath(repo)), false);

  // The failed pass still wrote its timestamp, so the next one waits five minutes.
  const after = withMaintenanceLock({ cwd: repo, now: NOW + MINUTE, stateFile: STATE_FILE }, () => 'again');
  assert.deepStrictEqual(after, { results: [] });
});

test('outside a git repo nothing runs and nothing is written', () => {
  const plain = freshDir('no-git');
  let calls = 0;
  const result = withMaintenanceLock({ cwd: plain, now: NOW, stateFile: STATE_FILE }, () => {
    calls += 1;
  });
  assert.deepStrictEqual(result, { results: [] });
  assert.strictEqual(calls, 0);
  assert.strictEqual(fs.existsSync(path.join(plain, '.atris')), false);
});

test('a linked work folder uses the main checkout state and waits on its lock', () => {
  const main = makeRepo('main');
  const linked = path.join(ROOT, 'linked-worktree');
  git(main, ['worktree', 'add', '-q', '--detach', linked]);

  let calls = 0;
  const ran = withMaintenanceLock({ cwd: linked, now: NOW, stateFile: STATE_FILE }, () => {
    calls += 1;
    return 'ran';
  });
  assert.strictEqual(ran, 'ran');
  assert.strictEqual(calls, 1);
  assert.strictEqual(readState(main).checked_at, NOW);
  assert.strictEqual(fs.existsSync(path.join(linked, '.atris')), false);

  writeLock(main, JSON.stringify({ pid: process.pid, at: NOW }));
  const blocked = withMaintenanceLock({ cwd: linked, now: NOW + 6 * MINUTE, stateFile: STATE_FILE }, () => {
    calls += 1;
  });
  assert.deepStrictEqual(blocked, { results: [] });
  assert.strictEqual(calls, 1);
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
