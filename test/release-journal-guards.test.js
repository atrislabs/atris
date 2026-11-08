'use strict';

// `atris release` refuses before writing anything when preflight fails, and a failed push
// leaves no stray local tag. Autopilot's journal entries land under the heading readers expect,
// with a fresh C number each time, and readers accept a bare "## Completed" too.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe', env: GIT_ENV }).trim();
}

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } }, null, 2) + '\n');
  git(root, ['add', 'package.json', 'package-lock.json']);
  git(root, ['commit', '-q', '-m', 'first']);
  git(root, ['tag', 'v1.0.0']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'second']);
  return root;
}

async function quietlyIn(dir, run) {
  const lines = [];
  const originalLog = console.log;
  const originalCwd = process.cwd();
  console.log = (...args) => lines.push(args.join(' '));
  process.chdir(dir);
  try {
    return { result: await run(), output: lines.join('\n') };
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
  }
}

test('release refuses and writes nothing when preflight fails', async (t) => {
  const { releaseAtris } = require('../commands/release');
  const repo = makeRepo(t);
  const head = git(repo, ['rev-parse', 'HEAD']);
  let asked = null;
  const { result, output } = await quietlyIn(repo, () => releaseAtris({ preflight: (opts) => { asked = opts; return 1; } }));
  assert.equal(result, 1);
  assert.equal(asked.tagVersion, '1.0.1', 'preflight checks the tag about to be made');
  assert.match(output, /release refused/);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
  assert.equal(git(repo, ['tag', '--list', 'v1.0.1']), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '1.0.0');
});

test('a push that fails deletes the local tag and prints the recovery', async (t) => {
  const { releaseAtris } = require('../commands/release');
  const repo = makeRepo(t);
  git(repo, ['remote', 'add', 'origin', path.join(repo, 'no-such-remote')]);
  const { result, output } = await quietlyIn(repo, () => releaseAtris({ preflight: () => 0 }));
  assert.equal(result, 1);
  assert.equal(git(repo, ['tag', '--list', 'v1.0.1']), '', 'no stray local tag blocks a retry');
  assert.match(output, /git push origin master && git tag v1\.0\.1 && git push origin v1\.0\.1/);
  assert.match(output, /git reset --hard HEAD~1/);
  assert.doesNotMatch(output, /github release created/);
});

test('preflight checks the tag it is given, not only the package version', (t) => {
  const { releasePreflight } = require('../commands/release');
  const repo = makeRepo(t);
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    releasePreflight({ cwd: repo, runTests: () => ({ status: 0 }), tagVersion: '1.0.0' });
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.includes('fail: tag v1.0.0 already exists'));
});

test('autopilot journal entries go under "## Completed ✅" with a new C number each time', (t) => {
  const { logCompletion } = require('../commands/autopilot');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(dir);
  let logFile;
  try {
    logCompletion('First finished job');
    logCompletion('Second finished job');
    logFile = require('../lib/file-ops').getLogPath().logFile;
  } finally {
    process.chdir(originalCwd);
  }
  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /## Completed ✅/);
  assert.match(content, /\*\*C1:\*\* First finished job/);
  assert.match(content, /\*\*C2:\*\* Second finished job/);
  assert.ok(!fs.existsSync(`${logFile}.lock`), 'the lock file is removed');
  // A journal with a bare heading still counts for the readers.
  const bare = '# Log\n\n## Completed\n\n- **C1:** Old entry\n';
  assert.match(bare, /## Completed(?: ✅)?[^\S\n]*\n[\s\S]*?- \*\*C\d+:/);
  const statusSrc = fs.readFileSync(path.join(__dirname, '..', 'commands', 'status.js'), 'utf8');
  assert.ok(statusSrc.includes('## Completed(?: ✅)?'), 'status reads both headings');
});
