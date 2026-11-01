'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function setup(t, gate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-merge-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = path.join(dir, 'primary');
  const work = path.join(dir, 'work');
  const remote = path.join(dir, 'remote.git');
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'gh.log');
  fs.mkdirSync(primary);
  fs.mkdirSync(bin);
  function git(args, cwd = primary) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '--bare', '-q', remote]);
  git(['init', '-q']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(primary, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(primary, 'app.txt'), 'initial\n');
  if (gate !== null) {
    fs.mkdirSync(path.join(primary, 'scripts'));
    fs.writeFileSync(path.join(primary, 'scripts', 'merge-gate.sh'), gate);
  }
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  git(['branch', '-M', 'master']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'master']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  git(['worktree', 'add', '-qb', 'feature', work, 'master']);
  fs.writeFileSync(path.join(work, 'app.txt'), 'changed\n');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.GH_LOG, args.join(' ') + '\\n');\nif (args[1] === 'list') console.log('[]');
else if (args[1] === 'view' && args.includes('--jq')) console.log('41 https://example.test/pull/41 OPEN');\nelse if (args[1] === 'view') console.log(JSON.stringify({state:'OPEN', mergedAt:null}));\nelse if (args[1] !== 'merge') process.exit(1);\n`, { mode: 0o755 });
  const env = { ...scrubAgentEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_LOG: log, ATRIS_SKIP_UPDATE_CHECK: '1' };
  function ship(args, extraEnv = {}, verify = 'test -f app.txt') {
    return spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'save change', '--verify', verify, '--no-map-refresh', ...args], {
      cwd: work, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 15000,
    });
  }
  return { dir, primary, work, remote, log, git, ship };
}

function assertUnmerged(ctx, result) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /branch.*left unmerged/i);
  assert.equal(ctx.git(['rev-parse', 'master']), ctx.git(['--git-dir', ctx.remote, 'rev-parse', 'master'], ctx.dir));
  if (fs.existsSync(ctx.log)) assert.doesNotMatch(fs.readFileSync(ctx.log, 'utf8'), /pr (merge|create)/, 'no pull request was changed');
  assert.notEqual(spawnSync('git', ['--git-dir', ctx.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0);
}

test('a passing gate runs after verify at the repository root on the committed head', (t) => {
  const ctx = setup(t, '#!/bin/sh\ntest -f app.txt || exit 8\ntest "$(git status --porcelain)" = "" || exit 9\nprintf "gate head: %s\\n" "$(git rev-parse HEAD)"\n');
  const result = ctx.ship(['--merge']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /merge gate: passed/);
  const head = ctx.git(['rev-parse', 'HEAD'], ctx.work);
  const landed = ctx.git(['--git-dir', ctx.remote, 'rev-parse', 'master'], ctx.dir);
  assert.equal(ctx.git(['rev-parse', `${landed}^2`], ctx.work), head);
  assert.doesNotMatch(fs.readFileSync(ctx.log, 'utf8'), /pr merge/);
});

test('a failed gate preserves the remote branch and pull request and reports its output', (t) => {
  const ctx = setup(t, '#!/bin/sh\necho first\necho "specific failure" >&2\nexit 23\n');
  const result = ctx.ship(['--merge']);
  assertUnmerged(ctx, result);
  assert.match(result.stderr, /scripts\/merge-gate\.sh/);
  assert.match(result.stderr, /exit code 23/);
  assert.match(result.stderr, /specific failure/);
});

test('a timed out gate reports the timeout and leaves the branch unmerged', (t) => {
  const ctx = setup(t, '#!/bin/sh\necho waiting\nexec sleep 10\n');
  const result = ctx.ship(['--merge'], { ATRIS_MERGE_GATE_TIMEOUT_MS: '100' });
  assertUnmerged(ctx, result);
  assert.match(result.stderr, /timed out/);
  assert.match(result.stderr, /exit code/);
  assert.match(result.stderr, /waiting/);
});

for (const change of ['echo changed >> app.txt', 'echo new > added.txt', 'echo changed >> app.txt; git add app.txt']) {
  test(`a gate that changes files refuses to merge: ${change}`, (t) => {
    const ctx = setup(t, `#!/bin/sh\n${change}\n`);
    const result = ctx.ship(['--merge']);
    assertUnmerged(ctx, result);
    assert.match(result.stderr, /changed files/);
    assert.match(result.stderr, /app\.txt|added\.txt/);
  });
}

test('local landing also runs the gate before touching the primary branch', (t) => {
  const ctx = setup(t, '#!/bin/sh\necho local failure\nexit 14\n');
  const before = ctx.git(['rev-parse', 'HEAD']);
  const result = ctx.ship(['--local', '--merge', '--target', 'master']);
  assertUnmerged(ctx, result);
  assert.equal(ctx.git(['rev-parse', 'HEAD']), before);
  assert.match(result.stderr, /exit code 14/);
});

test('local mode without merge still runs the gate', (t) => {
  const ctx = setup(t, '#!/bin/sh\nexit 15\n');
  const result = ctx.ship(['--local', '--target', 'master']);
  assertUnmerged(ctx, result);
  assert.match(result.stderr, /exit code 15/);
});

test('a push without landing does not run the gate', (t) => {
  const ctx = setup(t, '#!/bin/sh\nexit 42\n');
  const result = ctx.ship(['--no-pr']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /merge gate/);
});

test('without a gate the existing output contains no gate messages', (t) => {
  const ctx = setup(t, null);
  const result = ctx.ship(['--merge']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /merge gate/);
  assert.match(fs.readFileSync(ctx.log, 'utf8'), /pr merge/);
});


test('a passing gate permits a local landing', (t) => {
  const ctx = setup(t, '#!/bin/sh\ntest "$(git show HEAD:app.txt)" = changed\n');
  const result = ctx.ship(['--local', '--merge', '--target', 'master']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /merge gate: passed[\s\S]*merge: merged \(local mode\)/);
  assert.equal(ctx.git(['show', 'master:app.txt']), 'changed');
});

test('invalid timeout cannot turn off the gate', (t) => {
  const ctx = setup(t, '#!/bin/sh\nexit 0\n');
  const result = ctx.ship(['--merge'], { ATRIS_MERGE_GATE_TIMEOUT_MS: '0' });
  assertUnmerged(ctx, result);
  assert.match(result.stderr, /invalid atris_merge_gate_timeout_ms/);
});

test('a gate cannot change the checked commit', (t) => {
  const ctx = setup(t, '#!/bin/sh\necho altered >> app.txt\ngit add app.txt\ngit commit -qm altered\n');
  const result = ctx.ship(['--merge']);
  assertUnmerged(ctx, result);
  assert.match(result.stderr, /changed the commit/);
  assert.match(result.stderr, /app\.txt/);
});


test('the gate runs only after the requested verification passes', (t) => {
  const ctx = setup(t, '#!/bin/sh\ntest -f ../verified\n');
  const result = ctx.ship(['--merge'], {}, 'printf ready > ../verified');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verify:[\s\S]*merge gate: passed/);
});

test('a failed verification never starts the gate', (t) => {
  const ctx = setup(t, '#!/bin/sh\necho started > ../gate-ran\n');
  const result = ctx.ship(['--merge'], {}, 'exit 17');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'gate-ran')), false);
  assert.doesNotMatch(fs.readFileSync(ctx.log, 'utf8'), /pr (merge|create)/);
});

test('a failed gate leaves an existing remote branch and pull request alone', (t) => {
  const ctx = setup(t, '#!/bin/sh\necho fail\nexit 6\n');
  ctx.git(['push', 'origin', 'HEAD:refs/heads/feature'], ctx.work);
  const before = ctx.git(['--git-dir', ctx.remote, 'rev-parse', 'feature'], ctx.dir);
  const result = ctx.ship(['--merge']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /branch was left unmerged/);
  assert.equal(ctx.git(['--git-dir', ctx.remote, 'rev-parse', 'feature'], ctx.dir), before);
  assert.doesNotMatch(fs.readFileSync(ctx.log, 'utf8'), /pr (merge|create)/);
});

test('timeout stops gate descendants before they can keep writing', (t) => {
  const ctx = setup(t, '#!/bin/sh\n(sleep 2; echo survived > ../escaped) &\nwait\n');
  const result = ctx.ship(['--merge'], { ATRIS_MERGE_GATE_TIMEOUT_MS: '100' });
  assertUnmerged(ctx, result);
  spawnSync('sleep', ['3']);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'escaped')), false);
});
