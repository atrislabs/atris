'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches, failingLines, flagWhat, summaryLine, isGreenScratch } = require('../lib/land-green');

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commitAll(cwd, message, { when = THREE_DAYS_AGO } = {}) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Bench Author', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

// A repo whose verify is one line: the check passes only while ok.txt says ok.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-green-test-'));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Bench Author']);
  git(root, ['config', 'user.email', 'bench@example.com']);
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok\n');
  fs.writeFileSync(path.join(root, 'check.js'), "process.exit(require('fs').readFileSync('ok.txt','utf8').trim() === 'ok' ? 0 : 1);\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: 'node check.js' } }));
  commitAll(root, 'base', { when: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() });
  return root;
}

function branchWith(root, name, edit, { when } = {}) {
  git(root, ['checkout', '-q', '-b', name]);
  edit(root);
  const sha = commitAll(root, `${name} work`, { when });
  git(root, ['checkout', '-q', 'master']);
  return sha;
}

test('a stale branch that merges clean and passes the verify lands on master; a red one opens a flag instead', () => {
  const root = makeRepo();
  try {
    const greenSha = branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    branchWith(root, 'member/red', (dir) => fs.writeFileSync(path.join(dir, 'ok.txt'), 'broken\n'));
    const flags = [];
    const result = landStaleGreenBranches(root, {
      push: false,
      limit: 2,
      runCli: (args) => { flags.push(args); return { status: 0, stdout: 'opened CLS-1' }; },
    });

    assert.deepEqual(result.candidates.sort(), ['member/green', 'member/red']);
    assert.deepEqual(result.landed, ['member/green']);
    assert.deepEqual(result.red, ['member/red']);

    const masterLog = git(root, ['log', '--format=%s', 'master']);
    assert.match(masterLog, /member\/green work/);
    assert.doesNotMatch(masterLog, /member\/red work/);
    assert.equal(git(root, ['merge-base', '--is-ancestor', greenSha, 'master']), '');
    assert.equal(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8'), 'shipped\n', 'a clean master checkout fast-forwards its files too');
    assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'ok\n');

    const red = result.verdicts.find((v) => v.branch === 'member/red');
    assert.equal(red.action, 'red');
    assert.equal(red.reason, 'verify_failed');
    assert.equal(red.owner, 'Bench Author');
    assert.equal(flags.length, 1);
    assert.equal(flags[0][0], 'close');
    assert.equal(flags[0][1], 'add');
    assert.match(flags[0][2], /branch member\/red fails its checks and cannot land/);
    assert.ok(flags[0].includes('--owner') && flags[0].includes('Bench Author'));

    // No scratch checkout is left behind.
    const worktrees = git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
    assert.equal(worktrees.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh branches, conflicts, and dirty checkouts are held with a named reason and never verified', () => {
  const root = makeRepo();
  try {
    // Fresh work is not stale: it is not even a candidate.
    branchWith(root, 'member/fresh', (dir) => fs.writeFileSync(path.join(dir, 'fresh.txt'), 'x\n'), { when: new Date().toISOString() });
    // A conflicting branch edits the same line master later changed.
    branchWith(root, 'member/clash', (dir) => fs.writeFileSync(path.join(dir, 'ok.txt'), 'ok\nclash\n'));
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok\nmaster\n');
    commitAll(root, 'master moves', { when: new Date().toISOString() });
    // A branch someone is still editing in a side checkout.
    branchWith(root, 'member/busy', (dir) => fs.writeFileSync(path.join(dir, 'busy.txt'), 'x\n'));
    const side = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-green-side-'));
    fs.rmSync(side, { recursive: true, force: true });
    git(root, ['worktree', 'add', '-q', side, 'member/busy']);
    fs.writeFileSync(path.join(side, 'scratch.txt'), 'uncommitted\n');
    // The board treats a recently touched side checkout as activity; age it
    // so the branch is stale and only the dirty guard stands between it and a verify.
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(side, old, old);

    let verifies = 0;
    const result = landStaleGreenBranches(root, {
      push: false,
      limit: 5,
      runVerifyFn: () => { verifies += 1; return { status: 0, failing: [], command: 'x', duration_ms: 0, timed_out: false, tail: '' }; },
      runCli: () => ({ status: 0, stdout: '' }),
    });
    assert.equal(verifies, 0, 'nothing eligible should have reached the verify');
    assert.ok(!result.candidates.includes('member/fresh'));
    const byBranch = Object.fromEntries(result.verdicts.map((v) => [v.branch, v]));
    assert.equal(byBranch['member/clash'].action, 'skipped');
    assert.equal(byBranch['member/clash'].reason, 'merge_conflict');
    assert.equal(byBranch['member/busy'].action, 'skipped');
    assert.equal(byBranch['member/busy'].reason, 'checkout_dirty');
    assert.deepEqual(result.landed, []);
    git(root, ['worktree', 'remove', '--force', side]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one branch per tick by default; the rest wait with a named reason', () => {
  const root = makeRepo();
  try {
    branchWith(root, 'member/one', (dir) => fs.writeFileSync(path.join(dir, 'one.txt'), '1\n'));
    branchWith(root, 'member/two', (dir) => fs.writeFileSync(path.join(dir, 'two.txt'), '2\n'));
    const result = landStaleGreenBranches(root, { push: false, runCli: () => ({ status: 0, stdout: '' }) });
    assert.equal(result.landed.length, 1);
    assert.equal(result.verdicts.filter((v) => v.reason === 'per_tick_limit').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an erroring branch does not eat the tick: the next candidate still lands', () => {
  const root = makeRepo();
  try {
    // The broken branch is the most stale, so it is tried first.
    branchWith(root, 'member/broken', (dir) => fs.writeFileSync(path.join(dir, 'package-lock.json'), 'not json\n'), {
      when: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString(),
    });
    branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    const result = landStaleGreenBranches(root, { push: false, limit: 1, runCli: () => ({ status: 0, stdout: '' }) });
    const byBranch = Object.fromEntries(result.verdicts.map((v) => [v.branch, v]));
    assert.equal(byBranch['member/broken'].action, 'error', JSON.stringify(result.verdicts));
    assert.equal(byBranch['member/broken'].reason, 'install_failed');
    assert.deepEqual(result.landed, ['member/green']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a queue of erroring branches stops after a bounded run of misses', () => {
  const root = makeRepo();
  try {
    for (let i = 0; i < 5; i += 1) {
      branchWith(root, `member/broken-${i}`, (dir) => fs.writeFileSync(path.join(dir, 'package-lock.json'), 'not json\n'), {
        when: new Date(Date.now() - (3 + i * 0.5) * 24 * 3600 * 1000).toISOString(),
      });
    }
    const result = landStaleGreenBranches(root, { push: false, limit: 1, runCli: () => ({ status: 0, stdout: '' }) });
    const errors = result.verdicts.filter((v) => v.action === 'error' && v.reason === 'install_failed');
    const capped = result.verdicts.filter((v) => v.reason === 'attempt_cap');
    assert.equal(errors.length, 4, JSON.stringify(result.verdicts));
    assert.equal(capped.length, 1);
    assert.deepEqual(result.landed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry run names the eligible branch without touching master', () => {
  const root = makeRepo();
  try {
    branchWith(root, 'member/one', (dir) => fs.writeFileSync(path.join(dir, 'one.txt'), '1\n'));
    const before = git(root, ['rev-parse', 'master']);
    const result = landStaleGreenBranches(root, { push: false, dryRun: true });
    assert.equal(result.verdicts[0].reason, 'dry_run');
    assert.equal(git(root, ['rev-parse', 'master']), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a local master that lags origin lands onto the remote tip and pushes clean', () => {
  const root = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-green-origin-'));
  try {
    git(bare, ['init', '-q', '--bare', '-b', 'master']);
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-q', 'origin', 'master']);
    branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    // Origin moves ahead through someone else's clone.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-green-other-'));
    git(other, ['clone', '-q', bare, '.']);
    fs.writeFileSync(path.join(other, 'elsewhere.txt'), 'other\n');
    commitAll(other, 'someone else lands first', { when: new Date().toISOString() });
    git(other, ['push', '-q', 'origin', 'master']);

    const result = landStaleGreenBranches(root, { push: true, runCli: () => ({ status: 0, stdout: '' }) });
    assert.deepEqual(result.landed, ['member/green'], JSON.stringify(result.verdicts));
    const landed = result.verdicts[0];
    assert.equal(landed.push.ok, true, JSON.stringify(landed.push));
    const originLog = git(bare, ['log', '--format=%s', 'master']);
    assert.match(originLog, /member\/green work/);
    assert.match(originLog, /someone else lands first/);
    assert.equal(git(root, ['rev-parse', 'master']), git(bare, ['rev-parse', 'master']));
    assert.equal(fs.readFileSync(path.join(root, 'elsewhere.txt'), 'utf8'), 'other\n');
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('failing test names are lifted from node --test output and land in the flag text', () => {
  const out = [
    '✔ passes (1ms)',
    '✖ task status treats reviewed failures as closed task health (1112.214ms)',
    '✖ mission layers handles a missing runs directory (113.7ms)',
    '✖ failing tests:',
    '✖ task status treats reviewed failures as closed task health (1112.214ms)',
    'not ok 3 - bare tap line',
  ].join('\n');
  assert.deepEqual(failingLines(out), [
    'task status treats reviewed failures as closed task health',
    'mission layers handles a missing runs directory',
    '3 - bare tap line',
  ]);
  const what = flagWhat({ branch: 'member/x', verify: { failing: failingLines(out) } });
  assert.match(what, /^branch member\/x fails its checks and cannot land: task status treats/);
});

test('a branch of empty commits is a no-op, never a landing, and master does not move', () => {
  const root = makeRepo();
  try {
    git(root, ['checkout', '-q', '-b', 'member/empty']);
    git(root, ['-c', 'user.name=Bench Author', '-c', 'user.email=bench@example.com', 'commit', '-q', '--allow-empty', '-m', 'Start flight: empty'], {
      GIT_AUTHOR_DATE: THREE_DAYS_AGO,
      GIT_COMMITTER_DATE: THREE_DAYS_AGO,
    });
    git(root, ['checkout', '-q', 'master']);
    const before = git(root, ['rev-parse', 'master']);
    const result = landStaleGreenBranches(root, { push: false, openFlags: false });

    assert.deepEqual(result.candidates, ['member/empty']);
    assert.deepEqual(result.landed, []);
    const verdict = result.verdicts.find((v) => v.branch === 'member/empty');
    assert.equal(verdict.action, 'no_op');
    assert.equal(verdict.reason, 'empty_diff');
    assert.equal(git(root, ['rev-parse', 'master']), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a merge that reaches no branch is not called landed, and still spends the tick', () => {
  const root = makeRepo();
  try {
    branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    branchWith(root, 'member/second', (dir) => fs.writeFileSync(path.join(dir, 'second.txt'), 'shipped\n'));
    // A tracked edit on the master checkout blocks the fast-forward, and with
    // no remote nothing else carries the merge onto master.
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok\nlocal edit\n');
    const before = git(root, ['rev-parse', 'master']);
    const result = landStaleGreenBranches(root, { push: false, openFlags: false });

    assert.deepEqual(result.landed, []);
    const verdict = result.verdicts.find((v) => v.branch === 'member/green');
    assert.equal(verdict.action, 'not_landed');
    assert.equal(verdict.reason, 'content_not_on_target');
    assert.equal(git(root, ['rev-parse', 'master']), before);
    // The suite ran for the first branch, so the second waits for next tick.
    const second = result.verdicts.find((v) => v.branch !== verdict.branch);
    assert.equal(second.reason, 'per_tick_limit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a check that cannot fail, or that dirtied the merged tree, holds the merge before any push', () => {
  const root = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-green-origin-'));
  try {
    git(bare, ['init', '-q', '--bare', '-b', 'master']);
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-q', 'origin', 'master']);
    const originBefore = git(bare, ['rev-parse', 'master']);
    const localBefore = git(root, ['rev-parse', 'master']);
    branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));

    const hollow = landStaleGreenBranches(root, { push: true, verifyCommand: 'git diff --check', openFlags: false });
    assert.deepEqual(hollow.landed, []);
    assert.equal(hollow.verdicts[0].action, 'skipped');
    assert.equal(hollow.verdicts[0].reason, 'check_cannot_fail');
    assert.equal(git(bare, ['rev-parse', 'master']), originBefore, 'nothing was pushed');
    assert.equal(git(root, ['rev-parse', 'master']), localBefore, 'local master did not move');
    assert.match(summaryLine(hollow), /member\/green held \(check cannot fail/);

    // The check passed only after editing a changed file in the scratch tree,
    // so it did not run on the committed merge.
    const dirtied = landStaleGreenBranches(root, { push: true, verifyCommand: 'node check.js && echo extra >> feature.txt', openFlags: false });
    assert.deepEqual(dirtied.landed, []);
    assert.equal(dirtied.verdicts[0].action, 'skipped');
    assert.equal(dirtied.verdicts[0].reason, 'checked_uncommitted_files');
    assert.equal(git(bare, ['rev-parse', 'master']), originBefore, 'nothing was pushed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('with a remote, a merge that only moved the local branch is not landed', () => {
  const root = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-green-origin-'));
  try {
    git(bare, ['init', '-q', '--bare', '-b', 'master']);
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-q', 'origin', 'master']);
    const greenSha = branchWith(root, 'member/green', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    const result = landStaleGreenBranches(root, { push: false, openFlags: false });

    assert.deepEqual(result.landed, []);
    const verdict = result.verdicts[0];
    assert.equal(verdict.action, 'not_landed', JSON.stringify(verdict));
    assert.equal(verdict.reason, 'content_not_on_target');
    assert.equal(git(root, ['merge-base', '--is-ancestor', greenSha, 'master']), '', 'the local branch did move');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('a scratch folder kept because git is still busy in it is named in the verdict and the summary', () => {
  const root = makeRepo();
  let scratch = '';
  try {
    branchWith(root, 'member/busy', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    const result = landStaleGreenBranches(root, {
      push: false,
      verifyCommand: 'node check.js && touch "$(git rev-parse --git-dir)/index.lock"',
      runCli: () => ({ status: 0, stdout: '' }),
    });
    const verdict = result.verdicts.find((v) => v.branch === 'member/busy');
    const kept = /^(.+): git holds (.+index\.lock), under a minute old$/.exec(verdict.scratch_kept || '');
    assert.ok(kept, JSON.stringify(verdict));
    scratch = kept[1];
    assert.ok(fs.existsSync(scratch));
    assert.ok(fs.existsSync(kept[2]));
    assert.match(summaryLine(result), new RegExp(`member/busy scratch folder kept, ${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: git holds `));
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reap labels a kept green landing scratch folder as a landing copy, not a member copy', () => {
  const root = makeRepo();
  let scratch = '';
  try {
    branchWith(root, 'member/busy', (dir) => fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped\n'));
    const result = landStaleGreenBranches(root, {
      push: false,
      verifyCommand: 'node check.js && touch "$(git rev-parse --git-dir)/index.lock"',
      runCli: () => ({ status: 0, stdout: '' }),
    });
    scratch = result.verdicts[0].scratch_kept.split(': ')[0];
    assert.ok(isGreenScratch(scratch), scratch);
    assert.equal(isGreenScratch(root), false);
    const reaped = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'land', '--reap', '--force'], { cwd: root, encoding: 'utf8', timeout: 60000 });
    assert.equal(reaped.status, 0, reaped.stderr);
    assert.ok(reaped.stdout.includes(`kept, needs a human (green landing scratch copy): ${fs.realpathSync(scratch)} (git_lock: git holds `), reaped.stdout);
    assert.ok(fs.existsSync(scratch));
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reap removes a leftover scratch copy without force once git is idle in it, but keeps one holding a commit on no branch', () => {
  const root = makeRepo();
  const scratches = [];
  try {
    branchWith(root, 'member/red', (dir) => fs.writeFileSync(path.join(dir, 'ok.txt'), 'broken\n'));
    branchWith(root, 'member/odd', (dir) => fs.writeFileSync(path.join(dir, 'odd.txt'), 'x\n'));
    const result = landStaleGreenBranches(root, {
      push: false,
      limit: 2,
      verifyCommand: 'touch "$(git rev-parse --git-dir)/index.lock"; node check.js',
      runCli: () => ({ status: 0, stdout: '' }),
    });
    const byBranch = Object.fromEntries(result.verdicts.map((v) => [v.branch, v]));
    for (const name of ['member/red', 'member/odd']) {
      const scratch = byBranch[name].scratch_kept.split(': ')[0];
      scratches.push(scratch);
      fs.rmSync(path.join(git(scratch, ['rev-parse', '--git-dir']), 'index.lock'));
    }
    // A commit made in the copy itself rides no branch, so that copy stays.
    fs.writeFileSync(path.join(scratches[1], 'only-here.txt'), 'x\n');
    commitAll(scratches[1], 'made in the scratch copy');
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    for (const scratch of scratches) fs.utimesSync(scratch, old, old);
    const reaped = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'land', '--reap'], { cwd: root, encoding: 'utf8', timeout: 60000 });
    assert.equal(reaped.status, 0, reaped.stderr);
    assert.equal(fs.existsSync(scratches[0]), false, reaped.stdout);
    assert.ok(fs.existsSync(scratches[1]), reaped.stdout);
    assert.ok(reaped.stdout.includes(`(green landing scratch copy): ${fs.realpathSync(scratches[1])} (unlanded commits: `), reaped.stdout);
    const log = fs.readFileSync(path.join(root, '.atris', 'state', 'worktree_removals.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const entry = log.find((e) => e.by === 'atris land --reap');
    assert.equal(entry.reason, 'green_landing_scratch_left');
    assert.equal(git(root, ['rev-parse', '--verify', 'member/red']).length > 0, true);
  } finally {
    for (const scratch of scratches) fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
