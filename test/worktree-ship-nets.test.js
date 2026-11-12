const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { runShipNets, shipNets } = require('../commands/worktree');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const NET_FILES = [
  'test/repo-hygiene.test.js',
  'test/no-hardcoded-home-paths.test.js',
  'test/map-refs-accurate.test.js',
];
const FAILING_NET = "require('node:test')('fake net', () => { throw new Error('fake net failed'); });\n";
const PASSING_NET = "require('node:test')('fake net', () => {});\n";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-ship-nets-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFiles(root, files) {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
}

function capture(fn) {
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    return { result: fn(), stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function runCli(args, { cwd, env = {} } = {}) {
  const base = { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete base.ATRIS_SHIP_SKIP_NETS;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...base, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function setupRepo(dir, files) {
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  writeFiles(repo, {
    'README.md': '# Smoke\n',
    '.gitignore': '.atris/\n',
    'AGENTS.md': 'agent instructions\n',
    'CLAUDE.md': 'claude instructions\n',
    'GEMINI.md': 'gemini instructions\n',
    ...files,
  });
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  git(['branch', '-M', 'master']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'master']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  return { remote, repo, git };
}

function startCopy(dir, repo, name) {
  const worktreePath = path.join(dir, name);
  const start = runCli(['worktree', 'start', '--agent', 'codex-shipper', '--task', name, '--path', worktreePath], { cwd: repo });
  assert.equal(start.status, 0, start.stderr || start.stdout);
  fs.appendFileSync(path.join(worktreePath, 'README.md'), 'changed\n');
  return worktreePath;
}

function remoteHasBranch(remote, dir, worktreePath, git) {
  const branch = git(['branch', '--show-current'], worktreePath);
  const ref = spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', `refs/heads/${branch}`], { cwd: dir, encoding: 'utf8' });
  return ref.status === 0;
}

test('shipNets returns only the net files that exist, in the listed order', () => {
  const dir = makeTempDir();
  try {
    assert.deepEqual(shipNets(dir), []);
    writeFiles(dir, { 'test/map-refs-accurate.test.js': PASSING_NET, 'test/repo-hygiene.test.js': PASSING_NET, 'test/other.test.js': PASSING_NET });
    assert.deepEqual(shipNets(dir), ['test/repo-hygiene.test.js', 'test/map-refs-accurate.test.js']);
    writeFiles(dir, { 'test/no-hardcoded-home-paths.test.js': PASSING_NET });
    assert.deepEqual(shipNets(dir), NET_FILES);
  } finally {
    cleanupTempDir(dir);
  }
});

test('runShipNets says so and runs nothing when the repo has no nets', () => {
  const dir = makeTempDir();
  try {
    const run = capture(() => runShipNets(dir, { verify: 'npm test' }));
    assert.equal(run.stdout, 'nets: none in this repo');
    assert.deepEqual(run.result, { ok: true, ran: false, files: [] });
  } finally {
    cleanupTempDir(dir);
  }
});

test('runShipNets skips on the flag or on ATRIS_SHIP_SKIP_NETS=1 and never runs a failing net', () => {
  const dir = makeTempDir();
  try {
    writeFiles(dir, { 'test/repo-hygiene.test.js': FAILING_NET });
    const flagged = capture(() => runShipNets(dir, { skip: true, env: {} }));
    assert.equal(flagged.stdout, 'nets: skipped (--skip-nets)');
    assert.equal(flagged.result.ok, true);
    const fromEnv = capture(() => runShipNets(dir, { env: { ATRIS_SHIP_SKIP_NETS: '1' } }));
    assert.equal(fromEnv.stdout, 'nets: skipped (ATRIS_SHIP_SKIP_NETS=1)');
    assert.equal(fromEnv.result.ok, true);
    assert.equal(fromEnv.result.ran, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('runShipNets drops a net the verify command already names, so nothing runs twice', () => {
  const dir = makeTempDir();
  try {
    writeFiles(dir, { 'test/repo-hygiene.test.js': FAILING_NET, 'test/map-refs-accurate.test.js': PASSING_NET });
    const all = capture(() => runShipNets(dir, { dryRun: true, env: {} }));
    assert.match(all.stdout, /nets: node --test test\/repo-hygiene\.test\.js test\/map-refs-accurate\.test\.js/);
    assert.match(all.stdout, /nets: skipped \(dry-run\)/);
    assert.deepEqual(all.result.files, ['test/repo-hygiene.test.js', 'test/map-refs-accurate.test.js']);

    const one = capture(() => runShipNets(dir, { verify: 'node --test test/repo-hygiene.test.js', dryRun: true, env: {} }));
    assert.deepEqual(one.result.files, ['test/map-refs-accurate.test.js']);

    const both = capture(() => runShipNets(dir, { verify: 'node --test test/repo-hygiene.test.js test/map-refs-accurate.test.js', env: {} }));
    assert.equal(both.stdout, 'nets: covered by --verify');
    assert.deepEqual(both.result, { ok: true, ran: false, files: [] });
  } finally {
    cleanupTempDir(dir);
  }
});

test('runShipNets runs the nets for real: a passing set is ok and a failing set is not', () => {
  const dir = makeTempDir();
  try {
    writeFiles(dir, { 'test/repo-hygiene.test.js': PASSING_NET });
    const quiet = spawnSync(process.execPath, ['-e', `
      const { runShipNets } = require(${JSON.stringify(path.resolve(__dirname, '..', 'commands', 'worktree'))});
      const out = runShipNets(process.argv[1], { env: {} });
      process.exit(out.ok && out.ran ? 0 : 7);
    `, dir], { encoding: 'utf8' });
    assert.equal(quiet.status, 0, quiet.stderr || quiet.stdout);
    assert.match(quiet.stdout, /nets: node --test test\/repo-hygiene\.test\.js/);

    writeFiles(dir, { 'test/repo-hygiene.test.js': FAILING_NET });
    const failed = spawnSync(process.execPath, ['-e', `
      const { runShipNets } = require(${JSON.stringify(path.resolve(__dirname, '..', 'commands', 'worktree'))});
      const out = runShipNets(process.argv[1], { env: {} });
      process.exit(out.ok ? 0 : 9);
    `, dir], { encoding: 'utf8' });
    assert.equal(failed.status, 9, failed.stderr || failed.stdout);
    assert.match(failed.stderr, /nets: failed, fix before shipping/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('ship stops before the push when a net fails', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const { remote, repo, git } = setupRepo(dir, { 'test/repo-hygiene.test.js': FAILING_NET });
    worktreePath = startCopy(dir, repo, 'nets-fail-worktree');

    const shipped = runCli(['worktree', 'ship', '--message', 'ship with a failing net', '--verify', 'git status --short', '--no-pr'], { cwd: worktreePath });

    assert.equal(shipped.status, 1, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, /nets: node --test test\/repo-hygiene\.test\.js/);
    assert.match(shipped.stderr, /nets: failed, fix before shipping/);
    assert.doesNotMatch(shipped.stdout, /verify: git status/);
    assert.equal(remoteHasBranch(remote, dir, worktreePath, git), false, 'a failing net must stop before the push');
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('ship goes past a failing net with --skip-nets or ATRIS_SHIP_SKIP_NETS=1', () => {
  const dir = makeTempDir();
  const copies = [];
  try {
    const { remote, repo, git } = setupRepo(dir, { 'test/repo-hygiene.test.js': FAILING_NET });
    const cases = [
      ['nets-skip-flag-worktree', ['--skip-nets'], {}, /nets: skipped \(--skip-nets\)/],
      ['nets-skip-env-worktree', [], { ATRIS_SHIP_SKIP_NETS: '1' }, /nets: skipped \(ATRIS_SHIP_SKIP_NETS=1\)/],
    ];
    for (const [name, extra, env, line] of cases) {
      const worktreePath = startCopy(dir, repo, name);
      copies.push(worktreePath);
      const shipped = runCli(['worktree', 'ship', '--message', `ship ${name}`, '--verify', 'git status --short', '--no-pr', ...extra], { cwd: worktreePath, env });
      assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
      assert.match(shipped.stdout, line);
      assert.doesNotMatch(shipped.stderr, /nets: failed/);
      assert.equal(remoteHasBranch(remote, dir, worktreePath, git), true, `${name} should reach origin`);
    }
  } finally {
    for (const copy of copies) cleanupTempDir(copy);
    cleanupTempDir(dir);
  }
});

test('ship runs passing nets once and then pushes', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const { remote, repo, git } = setupRepo(dir, { 'test/repo-hygiene.test.js': PASSING_NET, 'test/map-refs-accurate.test.js': PASSING_NET });
    worktreePath = startCopy(dir, repo, 'nets-pass-worktree');

    const shipped = runCli(['worktree', 'ship', '--message', 'ship with passing nets', '--verify', 'node --test test/map-refs-accurate.test.js', '--no-pr'], { cwd: worktreePath });

    assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, /nets: node --test test\/repo-hygiene\.test\.js\n/, 'the verify names map-refs-accurate, so only hygiene is a net');
    assert.doesNotMatch(shipped.stdout, /nets: node --test.*map-refs-accurate/);
    assert.doesNotMatch(shipped.stderr, /nets: failed/);
    assert.equal(remoteHasBranch(remote, dir, worktreePath, git), true);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('ship in a repo without nets says so and ships', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const { remote, repo, git } = setupRepo(dir, {});
    worktreePath = startCopy(dir, repo, 'nets-none-worktree');

    const shipped = runCli(['worktree', 'ship', '--message', 'ship with no nets', '--verify', 'git status --short', '--no-pr'], { cwd: worktreePath });

    assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, /nets: none in this repo/);
    assert.equal(remoteHasBranch(remote, dir, worktreePath, git), true);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});

test('ship help documents --skip-nets', () => {
  const dir = makeTempDir();
  try {
    const shipHelp = runCli(['worktree', 'ship', '--help'], { cwd: dir });
    assert.equal(shipHelp.status, 0, shipHelp.stderr || shipHelp.stdout);
    assert.match(shipHelp.stdout, /\[--skip-nets\]/);
    assert.match(shipHelp.stdout, /nets run first/);
    const guide = runCli(['worktree', 'guide'], { cwd: dir });
    assert.equal(guide.status, 0, guide.stderr || guide.stdout);
    assert.match(guide.stdout, /--skip-nets/);
  } finally {
    cleanupTempDir(dir);
  }
});
