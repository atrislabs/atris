'use strict';

// A program can run a script from a work folder while its current folder is
// somewhere else (`node /path/to/folder/run.js` started from home). Cleanup
// used to look only at current folders, so it deleted the script out from
// under the running program.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { cleanupWorktrees, parseProcessArgPaths } = require('../commands/worktree');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-script-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'run.js\n');
  git(root, ['add', 'README.md', '.gitignore']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

function backdate(target, hours) {
  const stamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(target, stamp, stamp);
}

test('the program list reads script paths, including flag values', () => {
  const paths = parseProcessArgPaths([
    'node /work/a/run.js --port 3000',
    'node --require=/work/b/hook.js main.js',
    '/usr/bin/python3 -m http.server',
    '<defunct>',
    '',
  ].join('\n'));
  assert.ok(paths.includes('/work/a/run.js'));
  assert.ok(paths.includes('/work/b/hook.js'));
  assert.ok(paths.includes('/usr/bin/python3'));
  assert.equal(paths.includes('main.js'), false);
  assert.equal(paths.includes('--port'), false);
});

test('the program list keeps script paths that contain a space', () => {
  const paths = parseProcessArgPaths([
    'node /work/my folder/run.js --port 3000',
    'node --require=/work/b c/hook.js main.js',
  ].join('\n'));
  assert.ok(paths.some((p) => p.startsWith('/work/my folder/run.js')), JSON.stringify(paths));
  assert.ok(paths.some((p) => p.startsWith('/work/b c/hook.js')), JSON.stringify(paths));
});

async function keepsScriptFolder(folderSuffix) {
  const root = initRepo();
  const worktree = `${root}${folderSuffix}`;
  let child;
  try {
    git(root, ['worktree', 'add', '-q', '-b', 'script-home', worktree, 'HEAD']);
    const script = path.join(worktree, 'run.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    backdate(script, 2);
    backdate(worktree, 2);

    child = spawn(process.execPath, [script], { cwd: os.tmpdir(), stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    // No override: this goes through the real process scan.
    const applied = cleanupWorktrees({ root, base: 'HEAD', apply: true });
    assert.equal(applied.removed.length, 0, JSON.stringify(applied.removed));
    assert.equal(fs.existsSync(script), true);
    const kept = applied.kept.find((item) => fs.realpathSync(item.path) === fs.realpathSync(worktree));
    assert.ok(kept, JSON.stringify(applied.kept));
    assert.equal(kept.reason, 'active_process');

    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    child = null;

    // Ignored files are protected even after the program exits. Remove this
    // test-owned script explicitly before checking the clean-folder control.
    fs.unlinkSync(script);
    backdate(worktree, 2);
    const after = cleanupWorktrees({ root, base: 'HEAD', apply: true });
    assert.equal(after.removed.length, 1, JSON.stringify(after));
    assert.equal(fs.existsSync(worktree), false);
  } finally {
    if (child) child.kill('SIGKILL');
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('cleanup keeps a merged folder while a program started elsewhere runs a script inside it', async () => {
  await keepsScriptFolder('-script-home');
});

// The program list prints arguments without quotes, so a space in the folder
// name used to split the script path in two and the folder went unseen.
test('cleanup keeps a folder with a space in its name while a script inside it runs', async () => {
  await keepsScriptFolder('-script home');
});
