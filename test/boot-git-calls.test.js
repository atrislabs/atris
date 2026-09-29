'use strict';

// Every agent session starts with `atris atris.md`. Its human-fix gauge used
// to start one git process per recent commit, which made boot take seconds
// on a busy repo. This runs the real boot against a repo with many commits,
// with a logging git first on PATH, and checks git is asked a fixed number of
// questions: history once, commit files at most once, and on the next boot
// no commit files at all because they were saved by hash.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');
const BOT_TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';
const HOUR = 60 * 60 * 1000;

function git(args, cwd, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-boot-git-calls-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  // No ignore rule for .atris on purpose: user projects often have none.
  fs.mkdirSync(path.join(repo, '.atris'), { recursive: true });
  const start = Date.now() - 3 * 24 * HOUR;
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(repo, `f${Math.floor(i / 2) % 3}.js`), `v${i}\n`);
    const at = new Date(start + i * HOUR).toISOString();
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', `change ${i}${i % 2 ? '' : `\n\n${BOT_TRAILER}`}`], repo, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  }
  return { base, repo };
}

// A git that writes each subcommand to a log, then runs the real git. Leading
// `-c key=value` settings are skipped so `git -c ... diff-tree` logs diff-tree.
function makeGitLogger(base) {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'git-calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'sub=""',
    'skip=0',
    'for arg in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  if [ "$arg" = "-c" ]; then skip=1; continue; fi',
    '  sub="$arg"; break',
    'done',
    `echo "$sub" >> "${log}"`,
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, log };
}

function boot(repo, logger) {
  fs.rmSync(logger.log, { force: true });
  const result = spawnSync(process.execPath, [cliPath, 'atris.md'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${logger.bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.existsSync(logger.log) ? fs.readFileSync(logger.log, 'utf8').split('\n').filter(Boolean) : [];
  const count = (sub) => calls.filter((call) => call === sub).length;
  return { stdout: result.stdout, calls, count };
}

test('boot asks git for commit files once, then not at all on the next boot', { skip: process.platform === 'win32' }, (t) => {
  const { base, repo } = makeWorkspace();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const logger = makeGitLogger(base);

  const first = boot(repo, logger);
  assert.equal(first.count('log'), 1, `history is read once: ${first.calls.join(', ')}`);
  assert.ok(first.count('diff-tree') <= 1, `commit files come from one batch: ${first.calls.join(', ')}`);
  assert.equal(first.count('diff'), 0);

  const second = boot(repo, logger);
  assert.equal(second.count('log'), 1);
  assert.equal(second.count('diff-tree'), 0, `saved commit files are reused: ${second.calls.join(', ')}`);
  assert.equal(second.count('diff'), 0);
  assert.equal(second.stdout, first.stdout, 'the cache does not change what boot prints');
  assert.ok(!second.calls.includes('-c'), `every call is logged by its subcommand: ${second.calls.join(', ')}`);

  // Control: with the cache gone the next boot asks git for commit files
  // again, so the zero above is the cache at work and not a blind logger.
  fs.rmSync(path.join(repo, '.atris', 'cache'), { recursive: true, force: true });
  const cold = boot(repo, logger);
  assert.equal(cold.count('diff-tree'), 1, `a cold boot batches commit files: ${cold.calls.join(', ')}`);
  assert.equal(cold.stdout, first.stdout);
  assert.match(first.stdout, /landings? this week needed a human fix/);

  // The saved caches exist and can never be committed by accident.
  assert.ok(fs.existsSync(path.join(repo, '.atris', 'cache', 'revision-files.json')));
  git(['add', '-A'], repo);
  const staged = git(['diff', '--cached', '--name-only'], repo).split('\n').filter(Boolean);
  assert.deepEqual(staged.filter((file) => file.startsWith('.atris/cache')), []);
});
