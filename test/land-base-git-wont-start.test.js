'use strict';

// Under the desktop app's background sandbox the first git on cron's PATH
// (a stub that starts Xcode's git) will not start. Every git call failed and
// the lander said "no master/main branch found" on a repo that has one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ensureWorkingGit } = require('../lib/git-spawn');
const { collectBoard } = require('../commands/land');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function realGit() {
  return spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
}

// A folder whose git will not start, the way the sandboxed stub fails, and
// one whose git is a working one.
function gitFolders(tmp) {
  const broken = path.join(tmp, 'broken');
  const good = path.join(tmp, 'good');
  fs.mkdirSync(broken);
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(broken, 'git'), "#!/bin/sh\necho \"git: error: can't exec '/nowhere/git' (errno=Operation not permitted)\" >&2\nexit 71\n", { mode: 0o755 });
  fs.writeFileSync(path.join(good, 'git'), `#!/bin/sh\nexec "${realGit()}" "$@"\n`, { mode: 0o755 });
  return { broken, good };
}

// A main copy on a work branch with no local main or master: the base exists
// only on origin.
function originOnlyRepo(tmp) {
  const seed = path.join(tmp, 'seed');
  const bare = path.join(tmp, 'origin.git');
  const copy = path.join(tmp, 'copy');
  fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  git(seed, ['add', '-A']);
  git(seed, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base']);
  git(tmp, ['clone', '-q', '--bare', seed, bare]);
  git(tmp, ['clone', '-q', bare, copy]);
  git(copy, ['checkout', '-q', '-b', 'work']);
  git(copy, ['branch', '-q', '-D', 'main']);
  return copy;
}

test('a git that will not start is named as the problem, not a missing base branch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-git-'));
  const savedPath = process.env.PATH;
  try {
    const repo = originOnlyRepo(tmp);
    const { broken } = gitFolders(tmp);
    process.env.PATH = [broken, savedPath].join(path.delimiter);
    assert.throws(() => collectBoard(repo, { light: true }), (err) => {
      assert.equal(err.code, 'LAND_GIT_FAILED');
      assert.match(err.message, /git will not run here/);
      assert.match(err.message, /can't exec/);
      assert.doesNotMatch(err.message, /git checkout -b main/);
      return true;
    });
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('when the first git will not start, a working one goes first on PATH; a working PATH is left alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-git-'));
  try {
    const { broken, good } = gitFolders(tmp);
    const env = { PATH: [broken, '/usr/bin', '/bin'].join(path.delimiter), ATRIS_TOOL_DIRS: good };
    const fixed = ensureWorkingGit(env);
    assert.equal(fixed.ok, true);
    assert.equal(fixed.moved, good);
    assert.match(fixed.detail, /can't exec/);
    assert.equal(env.PATH.split(path.delimiter)[0], good);

    const fine = { PATH: [good, '/usr/bin', '/bin'].join(path.delimiter) };
    assert.deepEqual(ensureWorkingGit(fine), { ok: true });
    assert.equal(fine.PATH, [good, '/usr/bin', '/bin'].join(path.delimiter));

    const stuck = { PATH: broken, ATRIS_TOOL_DIRS: path.join(tmp, 'nothing-here') };
    const none = ensureWorkingGit(stuck);
    // The usual package folders may hold a working git on this computer.
    if (!none.ok) assert.match(none.detail, /can't exec/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('atris land finds the base on origin from a work branch even when the first git on PATH will not start', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-git-'));
  try {
    const repo = originOnlyRepo(tmp);
    const { broken, good } = gitFolders(tmp);
    const result = spawnSync(process.execPath, [BIN, 'land', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        HOME: tmp,
        PATH: [broken, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        ATRIS_TOOL_DIRS: good,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const board = JSON.parse(result.stdout);
    assert.equal(board.base, 'origin/main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
