'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn, spawnSync } = require('node:child_process');

async function main() {
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
  const { listActiveProcessPaths, worktreeHasActiveProcess } = require('../../commands/worktree');
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
  for (const kind of ['private', 'shared', 'quarantine', 'running', 'sibling', 'outside', 'outside-running']) {
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
    if (kind === 'running' || kind === 'outside-running') {
      const outside = kind === 'outside-running';
      const programFolder = outside ? path.join(root, `outside-${path.basename(parent)}`) : boundary.quarantine;
      if (outside) {
        git('--git-dir', boundary.gitDir, 'worktree', 'add', '-q', '--detach', programFolder, 'master');
        git('-C', programFolder, 'status', '--porcelain');
        const registered = git('--git-dir', boundary.gitDir, 'worktree', 'list', '--porcelain');
        assert.ok(registered.split('\n').includes(`worktree ${programFolder}`));
      }
      const child = spawn('sleep', ['30'], { cwd: programFolder, stdio: 'ignore' });
      try {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        process.kill(child.pid, 0);
        const activePaths = listActiveProcessPaths();
        assert.ok(Array.isArray(activePaths), 'the real process scan must succeed');
        assert.equal(worktreeHasActiveProcess(boundary.worktreePath, activePaths), false);
        assert.equal(worktreeHasActiveProcess(parent, activePaths), !outside);
        assert.equal(worktreeHasActiveProcess(programFolder, activePaths), true);
        assert.equal(inspectGitActivity(boundary.worktreePath).safe, true);
        assert.equal(inspectGitActivity(boundary.quarantine).safe, true);
        assert.equal(inspectGitActivity(programFolder).safe, true);
        console.log(`${kind} before cleanup: live program in ${programFolder}; parent scan reports ${outside ? 'clear' : 'active'}`);
        fleet.exports.auditDispose(boundary);
        process.kill(child.pid, 0);
        const removalFile = path.join(root, '.atris/state/worktree_removals.jsonl');
        assert.equal(fs.existsSync(parent), false, 'update this audit when group protection is implemented');
        assert.equal(fs.existsSync(removalFile), false);
        if (outside) {
          assert.equal(fs.existsSync(programFolder), true);
          const status = spawnSync('git', ['-C', programFolder, 'status', '--porcelain'], { encoding: 'utf8' });
          assert.notEqual(status.status, 0);
          assert.match(status.stderr, /not a git repository/);
          console.log(JSON.stringify({ kind, outsideFolderKept: true, outsideGitStatusExit: status.status }));
        }
        console.log(JSON.stringify({ kind, parentKept: false, programAlive: true, removalRecorded: false }));
      } finally {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        if (child.exitCode === null && child.signalCode === null) await exited;
      }
      continue;
    }
    const sibling = kind === 'outside' ? path.join(root, `outside-${path.basename(parent)}`) : path.join(parent, 'sibling');
    const linked = ['sibling', 'outside'].includes(kind);
    if (linked) {
      git('--git-dir', boundary.gitDir, 'worktree', 'add', '-q', '--detach', sibling, 'master');
    }
    const privateDir = git('-C', linked ? sibling : boundary.worktreePath, 'rev-parse', '--absolute-git-dir');
    const lock = ['private', 'sibling', 'outside'].includes(kind) ? path.join(privateDir, 'index.lock')
      : kind === 'shared' ? path.join(boundary.gitDir, 'refs/heads/master.lock')
        : path.join(boundary.quarantine, 'refs/heads/review.lock');
    fs.writeFileSync(lock, 'unfinished git work\n');
    const now = Date.now();
    const aged = new Date(now - 7200000);
    fs.utimesSync(lock, aged, aged);
    const workActivity = inspectGitActivity(boundary.worktreePath, now);
    const activity = kind === 'quarantine' ? inspectGitActivity(boundary.quarantine, now)
      : linked ? inspectGitActivity(sibling, now) : workActivity;
    if (linked) {
      assert.equal(workActivity.safe, true);
      assert.equal(inspectGitActivity(boundary.gitDir, now).safe, true);
      console.log(`${kind} case: work-folder and shared-repository checks both report safe`);
      if (kind === 'outside') {
        git('-C', sibling, 'status', '--porcelain');
        assert.equal(path.relative(parent, sibling).startsWith('..'), true);
      }
    }
    if (kind === 'quarantine') {
      assert.equal(workActivity.safe, true);
      console.log('quarantine case: work-folder-only check reports safe');
    }
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
    if (['quarantine', 'sibling', 'outside'].includes(kind)) {
      assert.equal(fs.existsSync(parent), false, 'update this audit when group protection is implemented');
      assert.equal(fs.existsSync(lock), false);
      assert.equal(lines.length, 0);
      if (kind === 'outside') {
        assert.equal(fs.existsSync(sibling), true);
        const status = spawnSync('git', ['-C', sibling, 'status', '--porcelain'], { encoding: 'utf8' });
        assert.notEqual(status.status, 0);
        assert.match(status.stderr, /not a git repository/);
        console.log(JSON.stringify({ kind, outsideFolderKept: true, outsideGitStatusExit: status.status, error: status.stderr.trim() }));
      }
    }
  }
  console.log('audit complete; surviving fixture data retained for inspection');
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
