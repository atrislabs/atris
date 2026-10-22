'use strict';

// The team supervisor puts member changes GitHub dropped from its merge line
// back in by itself, on a timer, so nobody has to type atris land --requeue.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { createMemberUp, memberMaintenance, CHECK_MS, REQUEUE_MS } = require('../lib/member-up');

// A supervisor with no members, a fake clock, and a put-back step that
// records each call and answers with whatever the test hands it.
function watcher(answer = () => ({ results: [] }), options = {}) {
  let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
  const lines = [];
  let calls = 0;
  const deps = {
    listMembers: () => options.members || [],
    pickTask: () => null,
    spawn: () => {},
    now: () => clock,
    print: (line) => lines.push(line),
    requeueDropped: () => {
      calls += 1;
      return answer(calls);
    },
  };
  const up = createMemberUp(deps, options);
  return { up, lines, calls: () => calls, advance(ms) { clock += ms; } };
}

test('first check puts dropped changes back and says so, then waits for the next look', () => {
  const w = watcher(() => ({
    results: [{ state: 'requeued', line: 'pull request #7 (codex/a): caught up with the main branch and queued again' }],
  }));
  w.up.check();
  assert.equal(w.calls(), 1);
  assert.deepEqual(w.lines, ['pull request #7 (codex/a): caught up with the main branch and queued again']);
  w.advance(CHECK_MS);
  w.up.check();
  assert.equal(w.calls(), 1, 'a member check alone does not call github again');
  w.advance(REQUEUE_MS - CHECK_MS);
  w.up.check();
  assert.equal(w.calls(), 2, 'the next look comes once the wait is up');
});

test('stays quiet when nothing was dropped, and names the ones left for a person', () => {
  const w = watcher(() => ({
    results: [
      { state: 'queued', line: 'pull request #1 (codex/a): still queued' },
      { state: 'merged', line: 'pull request #2 (codex/b): merged' },
      { state: 'clash', line: 'pull request #3 (codex/c): the branch clashes with the main branch; left for you' },
      { state: 'gave-up', line: 'pull request #4 (codex/d): dropped again after 3 catch-ups; left for you' },
    ],
  }));
  w.up.check();
  assert.deepEqual(w.lines, [
    'pull request #3 (codex/c): the branch clashes with the main branch; left for you',
    'pull request #4 (codex/d): dropped again after 3 catch-ups; left for you',
  ]);
});

test('a broken look is said once and never stops members from starting', () => {
  const started = [];
  let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
  const lines = [];
  const up = createMemberUp({
    listMembers: () => [{ name: 'a' }],
    pickTask: () => ({ id: 't1', title: 'fix it', metadata: { verify: 'node --test test/x.test.js' } }),
    spawn: (name) => started.push(name),
    now: () => clock,
    print: (line) => lines.push(line),
    requeueDropped: () => { throw new Error('gh: not logged in'); },
  });
  up.check();
  assert.deepEqual(started, ['a']);
  clock += REQUEUE_MS;
  up.check();
  assert.deepEqual(lines.filter((l) => l.includes('merge line')), ["could not check github's merge line: gh: not logged in"]);
});

test('a dry run never pushes or calls github', () => {
  const w = watcher(undefined, { dryRun: true });
  w.up.check();
  assert.equal(w.calls(), 0);
});

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// The real `atris member up`, in a checkout with self-landing on, one queued
// member change whose auto-merge GitHub dropped after master moved, and a
// fake gh on PATH that reports it so.
test('two real member windows catch up a dropped change only once', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-up-watch-'));
  try {
    const origin = path.join(base, 'origin.git');
    const main = path.join(base, 'main');
    const branch = 'codex/member-work';
    git(['init', '--bare', '-q', '-b', 'master', origin], base);
    git(['init', '-q', '-b', 'master', main], base);
    git(['config', 'user.email', 'test@example.com'], main);
    git(['config', 'user.name', 'Test'], main);
    fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
    fs.writeFileSync(path.join(main, '.gitignore'), '.atris/\n');
    git(['add', '.'], main);
    git(['commit', '-qm', 'init'], main);
    git(['remote', 'add', 'origin', origin], main);
    git(['push', '-q', 'origin', 'master'], main);
    fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), '{"enabled":true}');

    git(['checkout', '-q', '-b', branch], main);
    fs.writeFileSync(path.join(main, 'work.txt'), 'done\n');
    git(['add', 'work.txt'], main);
    git(['commit', '-qm', 'member work'], main);
    const pushed = git(['rev-parse', 'HEAD'], main);
    git(['push', '-q', 'origin', branch], main);
    git(['checkout', '-q', 'master'], main);
    fs.writeFileSync(path.join(main, 'other.txt'), 'other\n');
    git(['add', 'other.txt'], main);
    git(['commit', '-qm', 'master moves'], main);
    git(['push', '-q', 'origin', 'master'], main);
    const masterSha = git(['rev-parse', 'HEAD'], main);

    const queue = path.join(main, '.atris', 'state', 'autoland-queue.json');
    fs.mkdirSync(path.dirname(queue), { recursive: true });
    fs.writeFileSync(queue, JSON.stringify({
      schema: 'atris.autoland_queue.v1',
      entries: { [branch]: { branch, base: 'master', number: 7, pushed, requeues: 0 } },
    }));

    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(base, 'gh-calls.jsonl');
    const view = {
      number: 7, state: 'OPEN', headRefName: branch, baseRefName: 'master',
      headRefOid: pushed, isCrossRepository: false, autoMergeRequest: null,
    };
    fs.writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "const [a, b] = process.argv.slice(2);",
      `if (a === 'pr' && b === 'view') console.log(${JSON.stringify(JSON.stringify(view))});`,
    ].join('\n'), { mode: 0o755 });

    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const children = [0, 1].map(() => spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'member', 'up'], {
      cwd: main,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: home,
        ATRIS_HOME: path.join(home, '.atris'),
        ATRIS_TASKS_DB: path.join(home, 'tasks.db'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    let out = '';
    const exits = children.map((child) => {
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      return new Promise((resolve) => child.on('close', resolve));
    });
    let codes;
    try {
      const deadline = Date.now() + 30000;
      while ((out.match(/team is up/g) || []).length < 2 && Date.now() < deadline
        && children.every((child) => child.exitCode === null)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      children.forEach((child) => child.kill('SIGTERM'));
      codes = await Promise.all(exits);
    }
    assert.deepEqual(codes, [0, 0], out);
    t.diagnostic(`command: node bin/atris.js member up (two windows); exit: ${codes.join(', ')}\n${out.trim()}`);
    assert.match(out, /pull request #7 \(codex\/member-work\): caught up with the main branch and queued again/, out);
    const head = git(['ls-remote', origin, `refs/heads/${branch}`], base).split('\t')[0];
    assert.deepEqual(git(['rev-list', '--parents', '-n', '1', head], main).split(' ').slice(1), [pushed, masterSha]);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.filter((c) => c[1] === 'merge'), [['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', head]]);
    const entry = JSON.parse(fs.readFileSync(queue, 'utf8')).entries[branch];
    assert.equal(entry.requeues, 1);
    assert.equal(entry.pushed, head);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function maintenanceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-maintenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'master'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(root, 'code.txt'), 'before\n');
  git(['add', '.'], root);
  git(['commit', '-qm', 'before'], root);
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, before: git(['rev-parse', 'HEAD'], root) };
}

test('windows and restarted windows share cadence, including linked folders', (t) => {
  const { root, dir } = maintenanceFixture(t);
  const linked = path.join(root, 'linked');
  git(['worktree', 'add', '-q', '--detach', linked], root);
  let calls = 0;
  let now = Date.now();
  const pass = (cwd) => memberMaintenance({ cwd, now, requeueDropped: () => { calls++; return { results: [] }; } });
  pass(root);
  pass(linked);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(dir, 'member-up-maintenance.lock')), false);
  now += REQUEUE_MS;
  pass(linked);
  pass(root);
  assert.equal(calls, 2);
});

test('a dead owner is recovered, but a live owner holds even past the short lease', (t) => {
  const { root, dir } = maintenanceFixture(t);
  const lock = path.join(dir, 'member-up-maintenance.lock');
  const old = Date.now() - 60 * 60 * 1000;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: old }));
  fs.utimesSync(lock, old / 1000, old / 1000);
  let calls = 0;
  const pass = () => memberMaintenance({ cwd: root, requeueDropped: () => { calls++; return { results: [] }; } });
  pass();
  assert.equal(calls, 0);
  // A real process that exited gives a dead owner without a guessed pid.
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  fs.writeFileSync(lock, JSON.stringify({ pid: dead.pid, at: old }));
  pass();
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(lock), false);
});

test('an unfinished lock gets a grace period, and failure releases ownership', (t) => {
  const { root, dir } = maintenanceFixture(t);
  const lock = path.join(dir, 'member-up-maintenance.lock');
  fs.writeFileSync(lock, '');
  const pass = (now) => memberMaintenance({ cwd: root, now, requeueDropped: () => { throw new Error('offline'); } });
  assert.deepEqual(pass(Date.now()), { results: [] });
  assert.throws(() => pass(Date.now() + 3 * 60 * 1000), /offline/);
  assert.equal(fs.existsSync(lock), false);
});

test('two quiet hours with waiting jobs is said once across windows and resets after a merge', (t) => {
  const { root } = maintenanceFixture(t);
  let now = Date.now();
  let results = [{ state: 'queued' }];
  const pass = () => memberMaintenance({ cwd: root, now, requeueDropped: () => ({ results }) }).results;
  assert.equal(pass().some((r) => r.state === 'stalled'), false);
  now += 2 * 60 * 60 * 1000;
  assert.equal(pass().filter((r) => r.state === 'stalled').length, 1);
  now += REQUEUE_MS;
  assert.equal(pass().some((r) => r.state === 'stalled'), false);
  now += REQUEUE_MS;
  results = [{ state: 'merged' }, { state: 'queued' }];
  assert.equal(pass().some((r) => r.state === 'stalled'), false);
  now += 2 * 60 * 60 * 1000;
  results = [{ state: 'queued' }];
  assert.equal(pass().filter((r) => r.state === 'stalled').length, 1);
});

test('waiting tasks also trigger the quiet warning, and an empty queue clears the incident', (t) => {
  const { root } = maintenanceFixture(t);
  let now = Date.now();
  let waiting = [{}];
  const pass = () => memberMaintenance({ cwd: root, now, requeueDropped: () => ({ results: [] }), waitingTasks: () => waiting });
  pass();
  now += 2 * 60 * 60 * 1000;
  assert.equal(pass().results[0].state, 'stalled');
  now += REQUEUE_MS;
  waiting = [];
  assert.deepEqual(pass().results, []);
  now += REQUEUE_MS;
  waiting = [{}];
  assert.deepEqual(pass().results, []);
});

test('the members code copy advances only when it is a clean detached plain clone', (t) => {
  const { root, before } = maintenanceFixture(t);
  const origin = path.join(root, 'remote.git');
  git(['init', '--bare', '-q', '-b', 'master', origin], root);
  git(['remote', 'add', 'origin', origin], root);
  git(['push', '-q', 'origin', 'master'], root);
  const copy = path.join(root, 'copy');
  git(['clone', '-q', origin, copy], root);
  fs.writeFileSync(path.join(root, 'code.txt'), 'after\n');
  git(['add', 'code.txt'], root);
  git(['commit', '-qm', 'after'], root);
  git(['push', '-q', 'origin', 'master'], root);
  const after = git(['rev-parse', 'HEAD'], root);
  let now = Date.now();
  const pass = (codeRoot = copy) => {
    const out = memberMaintenance({ cwd: root, codeRoot, now, requeueDropped: () => ({ results: [] }) });
    now += REQUEUE_MS;
    return out;
  };
  pass(); // A named branch stays put.
  assert.equal(git(['rev-parse', 'HEAD'], copy), before);
  git(['checkout', '-q', '--detach'], copy);
  fs.writeFileSync(path.join(copy, 'code.txt'), 'my edit\n');
  pass();
  assert.equal(fs.readFileSync(path.join(copy, 'code.txt'), 'utf8'), 'my edit\n');
  fs.writeFileSync(path.join(copy, 'code.txt'), 'before\n');
  fs.writeFileSync(path.join(copy, 'untracked.txt'), 'keep\n');
  pass();
  assert.equal(git(['rev-parse', 'HEAD'], copy), before);
  fs.unlinkSync(path.join(copy, 'untracked.txt'));
  const linked = path.join(root, 'linked');
  git(['worktree', 'add', '-q', '--detach', linked, before], root);
  pass(linked);
  assert.equal(git(['rev-parse', 'HEAD'], linked), before);
  assert.equal(pass().results[0].state, 'refreshed');
  assert.equal(git(['rev-parse', 'HEAD'], copy), after);
  assert.equal(fs.readFileSync(path.join(copy, 'code.txt'), 'utf8'), 'after\n');
  assert.notEqual(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: copy }).status, 0);
});

// A finished mission run uses the same pass. It must not swallow the two-hour
// warning: nothing prints it there, and the team loop would then stay quiet.
test('a pass that does not announce leaves the quiet warning for the team loop', (t) => {
  const { root } = maintenanceFixture(t);
  let now = Date.now();
  const results = [{ state: 'queued' }];
  const pass = (announceQuiet) => memberMaintenance({ cwd: root, now, announceQuiet, requeueDropped: () => ({ results }) }).results;
  pass(true);
  now += 2 * 60 * 60 * 1000;
  assert.equal(pass(false).some((r) => r.state === 'stalled'), false);
  now += REQUEUE_MS;
  assert.equal(pass(true).filter((r) => r.state === 'stalled').length, 1);
});
