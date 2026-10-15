const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun, requeueDroppedAutolands } = require('../lib/member-autoland');

// Finished member work that reached GitHub but whose pull request never
// opened is written down, and the sweep comes back and opens it.

const BRANCH = 'codex/member-work';

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// A fake gh that logs each call and reads its answers from a config file:
// `list` for open pull requests, `createFails` and `mergeFails` to fail.
function writeFakeGh(bin, log, config) {
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));`,
    "const [a, b] = process.argv.slice(2);",
    "if (a === 'pr' && b === 'list') console.log(JSON.stringify(cfg.list || []));",
    "if (a === 'pr' && b === 'create') { if (cfg.createFails) { console.error('GraphQL: was submitted too quickly'); process.exit(1); } console.log('https://github.com/acme/repo/pull/7'); }",
    "if (a === 'pr' && b === 'merge' && cfg.mergeFails) process.exit(1);",
  ].join('\n'), { mode: 0o755 });
}

function fixture({ gh = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pushed-not-proposed-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(main, '.gitignore'), '.atris/\natris/runs/\natris/status/\n');
  git(['add', '.'], main);
  git(['commit', '-qm', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), '{"enabled":true}');
  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', BRANCH, worktree, 'master'], main);
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'done\n');
  git(['add', '.'], worktree);
  git(['commit', '-qm', 'member work'], worktree);
  const pushed = git(['rev-parse', 'HEAD'], worktree);

  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(base, 'gh-calls.jsonl');
  const config = path.join(base, 'gh-config.json');
  fs.writeFileSync(config, JSON.stringify(gh));
  writeFakeGh(bin, log, config);
  return { base, origin, main, worktree, bin, log, config, pushed };
}

const setGh = (fx, gh) => fs.writeFileSync(fx.config, JSON.stringify(gh));
const queuePath = (fx) => path.join(fx.main, '.atris', 'state', 'autoland-queue.json');
const readQueue = (fx) => JSON.parse(fs.readFileSync(queuePath(fx), 'utf8')).entries;
const remoteBranch = (fx) => git(['ls-remote', fx.origin, `refs/heads/${BRANCH}`], fx.base).split('\t')[0];

function writeQueue(fx, entries) {
  fs.mkdirSync(path.dirname(queuePath(fx)), { recursive: true });
  fs.writeFileSync(queuePath(fx), JSON.stringify({ schema: 'atris.autoland_queue.v1', entries }));
}

// The branch is on GitHub with no pull request, written down by an earlier run.
function pushedNotProposed(fx, extra = {}) {
  git(['push', '-q', 'origin', BRANCH], fx.worktree);
  writeQueue(fx, {
    [BRANCH]: {
      branch: BRANCH, base: 'master', number: 0, pushed: fx.pushed, requeues: 0,
      title: 'Board reads plainly', body: 'Board reads plainly; check passed.', ...extra,
    },
  });
}

function ghCalls(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// The receipt a real passing run saves, so the review gate lets it through.
function writeRunReceipt(fx) {
  const dir = path.join(fx.worktree, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const tree = git(['rev-parse', 'HEAD^{tree}'], fx.worktree);
  fs.writeFileSync(path.join(dir, `mission-mission-test-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    tree_hash: 'doctrine-only',
    clean: true,
    git_tree: tree,
    mission_id: 'mission-test',
    at,
    result: {
      kind: 'mission_run_summary',
      tick_count: 1,
      ticks: [{
        status: 'ran', tick_index: 1, engine_id: 'claude', verifier_passed: true, reviewed_git_tree: tree,
        referee_result: { passed: true, mode: 'engine', engine: 'codex', output: 'VERDICT: PASS' },
      }],
    },
  }));
}

function mission() {
  return {
    id: 'mission-test',
    objective: 'Tidy the member board so finished work reads plainly to the operator',
    owner: 'executor',
    runner: 'claude',
    lane: 'workspace',
    metadata: {},
    task_ids: [],
    verifier_result: { passed: true, command: 'git diff --check' },
    worktree: { branch: BRANCH },
    last_tick_at: '2000-01-01T00:00:00.000Z',
    last_tick_status: 'ran',
    last_tick_index: 1,
  };
}

function withFakeGh(fx, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${fx.bin}${path.delimiter}${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
}

test('pull request fails to open after the push: the branch is written down with no number', () => {
  const fx = fixture({ gh: { createFails: true } });
  writeRunReceipt(fx);
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, summary: 'Board reads plainly.', loadTask: () => null });
    assert.equal(out.auto_merge, false);
    assert.equal(out.gate, 'pull request');
    assert.match(out.line, /could not be opened/);
    assert.equal(remoteBranch(fx), fx.pushed, 'the branch reached github');
    const entry = readQueue(fx)[BRANCH];
    assert.equal(entry.number, 0);
    assert.equal(entry.pushed, fx.pushed);
    assert.equal(entry.base, 'master');
    assert.equal(entry.title, mission().objective.slice(0, 70));
    assert.equal(entry.body, 'Board reads plainly.');
  });
});

test('several pull requests already open: nothing is written down, there is nothing to propose', () => {
  const pr = (number) => ({ number, headRefName: BRANCH, baseRefName: 'master', headRefOid: 'x', isCrossRepository: false });
  const fx = fixture({ gh: { list: [pr(3), pr(4)] } });
  writeRunReceipt(fx);
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.gate, 'pull request');
    assert.match(out.line, /more than one/);
    assert.equal(fs.existsSync(queuePath(fx)), false);
  });
});

test('sweep opens the missing pull request and turns on auto-merge pinned to the pushed commit', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    pushedNotProposed(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.proposed, 1, out.line);
    assert.equal(out.results[0].state, 'proposed');
    assert.match(out.line, /1 pushed branch proposed for merging/);
    const calls = ghCalls(fx);
    assert.deepEqual(calls.map((c) => c[1]), ['list', 'create', 'merge']);
    assert.equal(calls[1][calls[1].indexOf('--title') + 1], 'Board reads plainly');
    assert.equal(calls[1][calls[1].indexOf('--body') + 1], 'Board reads plainly; check passed.');
    assert.deepEqual(calls[2], ['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', fx.pushed]);
    const entry = readQueue(fx)[BRANCH];
    assert.equal(entry.number, 7);
    assert.equal(entry.pushed, fx.pushed);
  });
});

test('sweep reuses a pull request someone opened by hand instead of opening a second one', () => {
  const fx = fixture({ gh: { list: [{ number: 12, headRefName: BRANCH, baseRefName: 'master', headRefOid: 'x', isCrossRepository: false }] } });
  withFakeGh(fx, () => {
    pushedNotProposed(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'proposed');
    const calls = ghCalls(fx);
    assert.equal(calls.some((c) => c[1] === 'create'), false);
    assert.deepEqual(calls.at(-1), ['pr', 'merge', '12', '--auto', '--merge', '--match-head-commit', fx.pushed]);
    assert.equal(readQueue(fx)[BRANCH].number, 12);
  });
});

test('opening fails again: kept and retried, then left for a person after three tries', () => {
  const fx = fixture({ gh: { createFails: true } });
  withFakeGh(fx, () => {
    pushedNotProposed(fx);
    let out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'unproposed');
    assert.match(out.results[0].line, /will try again/);
    assert.equal(readQueue(fx)[BRANCH].requeues, 1);
    out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(readQueue(fx)[BRANCH].requeues, 2);
    out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'gave-up');
    assert.match(out.results[0].line, /left for you/);
    assert.equal(readQueue(fx)[BRANCH], undefined);
  });
});

test('pull request opens but auto-merge fails: the number is kept so the next look re-arms it', () => {
  const fx = fixture({ gh: { mergeFails: true } });
  withFakeGh(fx, () => {
    pushedNotProposed(fx);
    const out = requeueDroppedAutolands({ cwd: fx.main });
    assert.equal(out.results[0].state, 'auto-merge');
    assert.equal(readQueue(fx)[BRANCH].number, 7);
  });
});

test('branch deleted or pushed by someone else: left alone, github is never asked', () => {
  const gone = fixture();
  withFakeGh(gone, () => {
    pushedNotProposed(gone);
    git(['push', '-q', 'origin', '--delete', BRANCH], gone.worktree);
    const out = requeueDroppedAutolands({ cwd: gone.main });
    assert.equal(out.results[0].state, 'gone');
    assert.deepEqual(ghCalls(gone), []);
    assert.equal(readQueue(gone)[BRANCH], undefined);
  });

  const changed = fixture();
  withFakeGh(changed, () => {
    pushedNotProposed(changed);
    fs.writeFileSync(path.join(changed.worktree, 'more.txt'), 'more\n');
    git(['add', '.'], changed.worktree);
    git(['commit', '-qm', 'someone else'], changed.worktree);
    git(['push', '-q', 'origin', BRANCH], changed.worktree);
    const out = requeueDroppedAutolands({ cwd: changed.main });
    assert.equal(out.results[0].state, 'changed');
    assert.deepEqual(ghCalls(changed), []);
  });
});
