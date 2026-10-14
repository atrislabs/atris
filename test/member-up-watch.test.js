'use strict';

// The team supervisor puts member changes GitHub dropped from its merge line
// back in by itself, on a timer, so nobody has to type atris land --requeue.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { createMemberUp, CHECK_MS, REQUEUE_MS } = require('../lib/member-up');

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
test('atris member up catches up a dropped member change and queues it again with no command typed', async () => {
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
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'member', 'up'], {
      cwd: main,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: home,
        ATRIS_HOME: path.join(home, '.atris'),
        ATRIS_TASKS_DB: path.join(home, 'tasks.db'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const exited = new Promise((resolve) => child.on('close', resolve));
    const deadline = Date.now() + 30000;
    while (!/queued again/.test(out) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill('SIGTERM');
    await exited;

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
