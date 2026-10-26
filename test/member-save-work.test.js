const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { saveLeftoverMemberWork } = require('../lib/member-save-work');

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repoWithWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-save-work-'));
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(['init', '-q', '-b', 'main'], main);
  fs.writeFileSync(path.join(main, 'app.js'), 'old\n');
  git(['add', '-A'], main);
  git(['commit', '-qm', 'seed'], main);
  const side = path.join(base, 'side');
  git(['worktree', 'add', '-q', '-b', 'navigator-job', side], main);
  git(['config', 'user.email', 't@t'], side);
  git(['config', 'user.name', 't'], side);
  return { base, main, side };
}

test('loose work in a member checkout is committed on its branch, atris state left out', () => {
  const { base, main, side } = repoWithWorktree();
  try {
    fs.writeFileSync(path.join(side, 'answers.json'), '{"line":3}\n');
    fs.writeFileSync(path.join(side, 'app.js'), 'new\n');
    fs.mkdirSync(path.join(side, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(side, '.atris', 'state', 'engines.json'), '{}\n');
    const saved = saveLeftoverMemberWork({ worktreePath: side, member: 'navigator', objective: 'find the bug line.\n\nwrite answers.json' });
    assert.equal(saved.saved, true);
    assert.deepEqual(saved.files.sort(), ['answers.json', 'app.js']);
    assert.equal(git(['show', 'navigator-job:answers.json'], main), '{"line":3}');
    assert.match(git(['log', '-1', '--format=%s', 'navigator-job'], main), /^navigator: find the bug line\.$/);
    assert.ok(fs.existsSync(path.join(side, '.atris', 'state', 'engines.json')));
    assert.equal(git(['status', '--porcelain', '--', '.atris'], side), '?? .atris/');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a member that already committed leaves nothing to save', () => {
  const { base, side } = repoWithWorktree();
  try {
    assert.deepEqual(saveLeftoverMemberWork({ worktreePath: side, member: 'executor' }), { saved: false, reason: 'nothing_left' });
    assert.equal(saveLeftoverMemberWork({}).reason, 'no_worktree');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a job that forbids commits keeps its changes loose', () => {
  const { base, side } = repoWithWorktree();
  try {
    fs.writeFileSync(path.join(side, 'app.js'), 'new\n');
    for (const objective of ['fix the failing test. do not create a commit.', "fix it, don't commit", 'fix it without committing']) {
      assert.equal(saveLeftoverMemberWork({ worktreePath: side, objective }).reason, 'job_forbids_commit');
    }
    assert.equal(git(['status', '--porcelain'], side), 'M app.js');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a do-not-commit job runs in the person\'s own folder, other jobs get a side checkout', () => {
  const { buildMemberRunStartArgs } = require('../commands/member');
  const { base, main } = repoWithWorktree();
  try {
    assert.ok(buildMemberRunStartArgs('executor', 'fix the failing test', [], main).includes('--worktree'));
    const loose = buildMemberRunStartArgs('executor', 'fix the failing test.\n\ndo not create a commit.', [], main);
    assert.ok(!loose.includes('--worktree'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('review of PR 1650: secrets, staged atris state, and the main checkout stay out of the auto-save', () => {
  const { jobForbidsCommit } = require('../lib/member-save-work');
  const { base, main, side } = repoWithWorktree();
  try {
    fs.writeFileSync(path.join(side, 'app.js'), 'new\n');
    fs.writeFileSync(path.join(side, 'credentials.json'), '{"key":"x"}\n');
    fs.writeFileSync(path.join(side, '.env'), 'TOKEN=x\n');
    fs.mkdirSync(path.join(side, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(side, '.atris', 'secret.json'), '{}\n');
    git(['add', '-f', '.atris/secret.json'], side);
    const saved = saveLeftoverMemberWork({ worktreePath: side, member: 'executor', objective: 'fix app.js' });
    assert.equal(saved.saved, true);
    assert.deepEqual(saved.files, ['app.js']);
    assert.deepEqual(saved.skipped.sort(), ['.env', 'credentials.json']);
    assert.equal(git(['show', '--name-only', '--format=', 'navigator-job'], main), 'app.js');

    fs.writeFileSync(path.join(main, 'app.js'), 'edited in main\n');
    assert.equal(saveLeftoverMemberWork({ worktreePath: main, objective: 'fix app.js' }).reason, 'not_side_checkout');

    assert.equal(jobForbidsCommit('fix app.js; do not create any commits'), true);
    assert.equal(jobForbidsCommit('fix app.js, no commits please'), true);
    assert.equal(jobForbidsCommit('fix app.js and commit it'), false);
    assert.equal(jobForbidsCommit('fix parser; no empty commits'), false);
    assert.equal(jobForbidsCommit('fix it without committing'), true);
    assert.equal(jobForbidsCommit('fix parser; do not make any new commits'), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('review of PR 1650: an explicit --worktree keeps the side checkout even on a do-not-commit job', () => {
  const { buildMemberRunStartArgs } = require('../commands/member');
  const { base, main } = repoWithWorktree();
  try {
    assert.ok(buildMemberRunStartArgs('executor', 'fix app.js; do not commit', ['--worktree'], main).includes('--worktree'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ordinary files whose names mention tokens or secrets still get saved', () => {
  const { base, side } = repoWithWorktree();
  try {
    for (const name of ['tokenizer.js', 'token-bucket.js', 'secrets-manager.js', 'password-reset.md']) {
      fs.writeFileSync(path.join(side, name), 'x\n');
    }
    const saved = saveLeftoverMemberWork({ worktreePath: side, member: 'executor', objective: 'add helpers' });
    assert.deepEqual(saved.files.sort(), ['password-reset.md', 'secrets-manager.js', 'token-bucket.js', 'tokenizer.js']);
    assert.equal(saved.skipped, undefined);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the save refuses the main checkout even when git reports relative directories', () => {
  const { base, main } = repoWithWorktree();
  try {
    fs.mkdirSync(path.join(main, 'sub'));
    fs.writeFileSync(path.join(main, 'sub', 'x.js'), 'x\n');
    assert.equal(saveLeftoverMemberWork({ worktreePath: main, objective: 'fix' }).reason, 'not_side_checkout');
    assert.equal(saveLeftoverMemberWork({ worktreePath: path.join(main, 'sub'), objective: 'fix' }).reason, 'not_side_checkout');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('secret folders and bare credentials files stay out of the auto-save', () => {
  const { base, side } = repoWithWorktree();
  try {
    for (const rel of ['.aws/credentials', '.ssh/config', 'deploy/credentials', 'app.js']) {
      fs.mkdirSync(path.dirname(path.join(side, rel)), { recursive: true });
      fs.writeFileSync(path.join(side, rel), 'x\n');
    }
    const saved = saveLeftoverMemberWork({ worktreePath: side, member: 'executor', objective: 'fix app.js' });
    assert.deepEqual(saved.files, ['app.js']);
    assert.deepEqual(saved.skipped.sort(), ['.aws/credentials', '.ssh/config', 'deploy/credentials']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('work is saved unchecked when the reviewer timed out, never when it said no or the tests failed', () => {
  const { memberRunSaveDecision } = require('../commands/member');
  assert.equal(memberRunSaveDecision({ started: true, ok: true, verdict: { passed: true } }), 'checked');
  // Member lab: the reviewer confirmed the answer but timed out before its verdict.
  assert.equal(memberRunSaveDecision({ started: true, ok: false, verdict: { passed: false, mode: 'engine-unavailable', timed_out: true } }), 'unchecked');
  assert.equal(memberRunSaveDecision({ started: true, ok: false, verdict: { passed: false, status: 0, referee: { mode: 'engine-unavailable' } } }), 'unchecked');
  assert.equal(memberRunSaveDecision({ started: true, ok: false, verdict: { passed: false, status: 1, referee: { mode: 'engine-unavailable' } } }), '');
  assert.equal(memberRunSaveDecision({ started: true, ok: false, verdict: { passed: false, status: 0, referee: { mode: 'engine', passed: false } } }), '');
  assert.equal(memberRunSaveDecision({ started: false, ok: false, verdict: { passed: true } }), '');
});
