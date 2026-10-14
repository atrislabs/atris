'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

function main() {
  // Keep inherited commit-hook Git settings away from the disposable fixture.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) delete process.env[name];
  }
  const sourcePath = require.resolve('../../lib/fleet');
  const fleet = new Module(sourcePath, module);
  fleet.filename = sourcePath;
  fleet.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  // Expose the private routine in memory, without changing its implementation
  // or replacing filesystem operations, Git, or any imported helper.
  fleet._compile(`${fs.readFileSync(sourcePath, 'utf8')}\nmodule.exports.auditDispose = disposeReviewSandbox;\n`, sourcePath);
  const { inspectGitActivity } = require('../../lib/git-activity');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-check-')));
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'README.md'), '# disposable fixture\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  console.log(`fixture: ${root}`);
  for (const kind of ['private', 'shared']) {
    const parent = fs.mkdtempSync(path.join(root, 'review-'));
    const boundary = {
      trustedRoot: root,
      sandboxRoot: parent,
      worktreePath: path.join(parent, 'work'),
      gitDir: path.join(parent, 'objects.git'),
      quarantine: path.join(parent, 'quarantine.git'),
    };
    git('clone', '-q', '--bare', root, boundary.gitDir);
    git('init', '-q', '--bare', boundary.quarantine);
    git('--git-dir', boundary.gitDir, 'worktree', 'add', '-q', boundary.worktreePath, 'master');
    const privateDir = git('-C', boundary.worktreePath, 'rev-parse', '--absolute-git-dir');
    const lock = kind === 'private' ? path.join(privateDir, 'index.lock')
      : path.join(boundary.gitDir, 'refs/heads/master.lock');
    fs.writeFileSync(lock, 'unfinished git work\n');
    const now = Date.now();
    const aged = new Date(now - 7200000);
    fs.utimesSync(lock, aged, aged);
    const activity = inspectGitActivity(boundary.worktreePath, now);
    assert.equal(activity.safe, false);
    assert.ok(activity.locks.some((item) => item.path === lock && item.ageSeconds === 7200));
    console.log(`${kind} before cleanup: ${activity.reason}`);
    fleet.exports.auditDispose(boundary);
    const removalFile = path.join(root, '.atris/state/worktree_removals.jsonl');
    const lines = fs.existsSync(removalFile) ? fs.readFileSync(removalFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    console.log(JSON.stringify({
      kind, folderKept: fs.existsSync(boundary.worktreePath), lockKept: fs.existsSync(lock),
      parentKept: fs.existsSync(parent), removalRecorded: lines.some((line) => line.path === boundary.worktreePath),
    }));
  }
  console.log('audit complete; surviving fixture data retained for inspection');
}

if (require.main === module) main();
