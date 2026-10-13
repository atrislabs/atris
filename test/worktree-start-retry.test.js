'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAgentWorktree } = require('../commands/worktree');

function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-start-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'branch.autoSetupMerge', 'always']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return { dir, root, git, target: path.join(dir, 'worker') };
}

for (const phase of ['add', 'metadata']) {
test(`a real config lock during ${phase} retries and completes with metadata`, (t) => {
  const { dir, root, git, target } = room(t);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(dir, 'attempts');
  const lock = path.join(root, '.git', 'config.lock');
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (${phase === 'add' ? "args[0] === 'worktree' && args[1] === 'add'" : "args[0] === 'config' && args[1].endsWith('.atris-base')"}) {
  if (!fs.existsSync(${JSON.stringify(marker)})) {
    fs.writeFileSync(${JSON.stringify(lock)}, 'another writer');
    spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').unlinkSync(${JSON.stringify(lock)}), 250)`)}], { stdio: 'ignore' }).unref();
  }
  fs.appendFileSync(${JSON.stringify(marker)}, 'add\\n');
}
const run = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(run.status ?? 1);
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  const created = createAgentWorktree({ root, agent: 'tester', task: 'lock retry', path: target, base: 'HEAD' });
  const attempts = fs.readFileSync(marker, 'utf8').trim().split('\n').length;
  assert.ok(attempts > 1 && attempts <= 3, `bounded attempts: ${attempts}`);
  assert.equal(fs.existsSync(path.join(created.path, 'source.txt')), true);
  assert.equal(git(['config', '--get', `branch.${created.branch}.atris-owner`]), 'tester');
});
}

test('an exhausted start removes its new branch so the next start is not an overlap', (t) => {
  const { root, target, git } = room(t);
  const now = new Date();
  const lock = path.join(root, '.git', 'config.lock');
  fs.writeFileSync(lock, 'another writer');
  assert.throws(() => createAgentWorktree({ root, agent: 'tester', task: 'failed start', path: target, base: 'HEAD', now }), /could not lock config file/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another writer', 'never remove another writer’s lock');
  fs.unlinkSync(lock);
  assert.equal(git(['branch', '--format=%(refname:short)']).split('\n').length, 1);
  const next = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'start', '--agent', 'tester', '--task', 'failed start', '--path', target, '--base', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stderr, /overlapping flight/);
  assert.equal(fs.existsSync(target), true);
});

test('an existing branch survives a failed creation', (t) => {
  const { root, target, git } = room(t);
  git(['branch', 'existing', 'HEAD']);
  const before = git(['rev-parse', 'existing']);
  assert.throws(() => createAgentWorktree({ root, agent: 'tester', task: 'existing', branch: 'existing', path: target, base: 'HEAD' }), /already exists/);
  assert.equal(git(['rev-parse', 'existing']), before);
});
