const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun } = require('../lib/member-autoland');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// A main checkout with a bare origin, a mission worktree on its own branch,
// and a fake gh on PATH that appends each call's arguments to a log.
function fixture({ policy } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-autoland-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  git(['add', '.'], main);
  git(['commit', '-m', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  if (policy !== undefined) {
    fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), policy);
  }
  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', 'codex/member-work', worktree, 'master'], main);
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'done\n');
  git(['add', '.'], worktree);
  git(['commit', '-q', '-m', 'member work'], worktree);

  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "if (process.argv[2] === 'pr' && process.argv[3] === 'create') console.log('https://github.com/acme/repo/pull/7');",
  ].join('\n'), { mode: 0o755 });
  return { base, origin, worktree, bin, log };
}

function ghCalls(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function mission(overrides = {}) {
  return {
    id: 'mission-test',
    objective: 'Tidy the member board so finished work reads plainly to the operator every morning',
    owner: 'executor',
    runner: 'claude',
    lane: 'workspace',
    metadata: {},
    task_ids: [],
    verifier_result: { passed: true, command: 'git diff --check' },
    review_verdict: { passed: true, reviewer: 'codex' },
    worktree: { branch: 'codex/member-work' },
    ...overrides,
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

test('policy missing: branch stays, gh is never called', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, false);
    assert.equal(out.gate, 'policy');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('policy on and every gate passes: pushes, opens a pull request, turns on auto-merge only', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true, owner: 'keshav' }) });
  withFakeGh(fx, () => {
    const m = mission();
    const out = autolandMemberRun({ mission: m, cwd: fx.worktree, summary: 'Board reads plainly; check passed.', loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    assert.equal(out.url, 'https://github.com/acme/repo/pull/7');
    assert.match(out.line, /pull\/7/);
    const calls = ghCalls(fx);
    assert.deepEqual(calls[0].slice(0, 2), ['pr', 'create']);
    assert.equal(calls[0][calls[0].indexOf('--title') + 1], m.objective.slice(0, 70));
    assert.equal(calls[0][calls[0].indexOf('--body') + 1], 'Board reads plainly; check passed.');
    assert.deepEqual(calls[1], ['pr', 'merge', 'codex/member-work', '--auto', '--merge']);
    assert.equal(calls.length, 2);
    for (const call of calls.filter((c) => c[1] === 'merge')) assert.ok(call.includes('--auto'), 'never a plain merge');
    assert.ok(git(['ls-remote', fx.origin, 'refs/heads/codex/member-work'], fx.base), 'branch pushed');
  });
});

test('protected mission metadata: branch stays, gh is never called', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({
      mission: mission({ metadata: { protected_lane_note: 'Never self-land: touches session minting.' } }),
      cwd: fx.worktree,
      loadTask: () => null,
    });
    assert.equal(out.gate, 'protected');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('linked billing task: branch stays, gh is never called', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({
      mission: mission({ task_ids: ['T-1'] }),
      cwd: fx.worktree,
      loadTask: (id) => ({ id, tag: 'billing', title: 'Fix the plan page', metadata: {} }),
    });
    assert.equal(out.gate, 'protected');
    assert.match(out.line, /billing/);
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('no review verdict: branch stays, gh is never called', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    for (const verdict of [undefined, { passed: true, reviewer: 'executor' }, { passed: false, reviewer: 'codex' }]) {
      const out = autolandMemberRun({ mission: mission({ review_verdict: verdict }), cwd: fx.worktree, loadTask: () => null });
      assert.equal(out.gate, 'review');
    }
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('malformed or switched-off policy holds the branch too', () => {
  for (const policy of ['{not json', JSON.stringify({ enabled: 'true' }), JSON.stringify({ enabled: false })]) {
    const fx = fixture({ policy });
    withFakeGh(fx, () => {
      const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
      assert.equal(out.gate, 'policy');
      assert.deepEqual(ghCalls(fx), []);
    });
  }
});
