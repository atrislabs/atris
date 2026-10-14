'use strict';

// Run the production green-landing routine with real Git. Its verify step is
// replaced so each case can leave the scratch copy clean, holding aged
// private and shared Git locks, or moved away, then check what teardown did.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OLD = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

function main() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) delete process.env[name];
  }
  const { landStaleGreenBranches } = require('../../lib/land-green');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-green-scratch-')));
  console.log(`fixture: ${base}`);
  for (const mode of ['clean', 'locked', 'moved']) {
    const root = path.join(base, mode);
    fs.mkdirSync(root);
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'master');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'member/work');
    fs.writeFileSync(path.join(root, 'feature.txt'), 'work\n');
    git('add', '.');
    git('commit', '-qm', 'member work');
    git('checkout', '-q', 'master');

    let scratch = null;
    let expected = [];
    const moved = path.join(base, `${mode}-moved-scratch`);
    const runVerifyFn = (command, cwd) => {
      scratch = cwd;
      const privateDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).stdout.trim();
      if (mode !== 'clean') {
        expected = [[path.join(privateDir, 'index.lock'), 10800], [path.join(root, '.git', 'packed-refs.lock'), 14400]];
        for (const [file, seconds] of expected) {
          fs.writeFileSync(file, 'fixture lock\n');
          const aged = new Date(Date.now() - seconds * 1000);
          fs.utimesSync(file, aged, aged);
        }
      }
      if (mode === 'moved') fs.renameSync(cwd, moved);
      return { status: 1, stdout: 'not ok 1 fixture check\n', stderr: '', command };
    };
    const savedError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    let result;
    try {
      result = landStaleGreenBranches(root, { push: false, openFlags: false, runVerifyFn });
    } finally {
      console.error = savedError;
    }
    console.log(`case: ${mode}`);
    console.log(`verdict: ${result.verdicts.map((v) => `${v.branch} ${v.action}`).join(', ')}`);
    for (const line of errors) console.log(`stderr: ${line}`);
    assert.deepEqual(result.red, ['member/work']);
    assert.ok(scratch, 'the verify step never ran in a scratch copy');
    const registered = git('worktree', 'list', '--porcelain').includes(`worktree ${scratch}\n`);
    const removalFile = path.join(root, '.atris', 'state', 'worktree_removals.jsonl');
    const removals = fs.existsSync(removalFile) ? fs.readFileSync(removalFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    if (mode === 'clean') {
      assert.equal(fs.existsSync(scratch), false);
      assert.equal(registered, false);
      assert.equal(removals.length, 1, 'clean scratch removal was not logged');
      assert.equal(removals[0].path, scratch);
      assert.equal(removals[0].by, 'atris land green');
      assert.equal(removals[0].reason, 'scratch_check_finished');
      console.log(`removal recorded: ${JSON.stringify(removals[0])}`);
      continue;
    }
    const line = errors.find((l) => l.startsWith(`land green: kept scratch copy ${scratch}: `));
    assert.ok(line, errors.join('\n') || 'nothing reported for the kept scratch copy');
    assert.ok(line.includes(mode === 'moved' ? 'folder is missing; git lock: ' : 'git locks: '), line);
    for (const [file, seconds] of expected) {
      const age = line.split(`${file} (`)[1]?.match(/^(\d+)s old\)/);
      assert.ok(age && Math.abs(Number(age[1]) - seconds) <= 10, line);
      assert.ok(fs.existsSync(file));
    }
    assert.equal(fs.existsSync(mode === 'moved' ? moved : scratch), true);
    assert.equal(registered, true, 'the scratch copy record was dropped');
    assert.equal(removals.length, 0);
    // A kept scratch copy sits outside the fixture; report it for removal.
    if (fs.existsSync(scratch)) console.log(`fixture: ${scratch}`);
  }
  console.log('clean scratch copy removed and logged; scratch copies holding aged private and shared locks, in place or moved, were kept with each lock path and age named, their Git record retained, and no removal recorded');
}

if (require.main === module) main();
