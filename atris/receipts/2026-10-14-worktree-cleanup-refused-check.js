'use strict';

// Run the real worktree cleanup command and real git. A forwarding git
// executable locks the merged copy and adds aged private and shared locks at
// removal, after every check has passed, so real Git refuses. In the second
// case the copy also moves before Git answers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), ATRIS_NO_UPDATE_CHECK: '1' };
const located = spawnSync('which', ['git'], { env, encoding: 'utf8' });
assert.equal(located.status, 0, located.stderr);
const realGit = located.stdout.trim();
const cli = path.resolve(__dirname, '../../bin/atris.js');

function git(cwd, ...args) {
  const result = spawnSync(realGit, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function main() {
  for (const mode of ['refused', 'refused-moved']) {
    const moves = mode === 'refused-moved';
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cleanup-refused-')));
    console.log(`fixture: ${base}`);
    const repo = path.join(base, 'repo');
    const toolsDir = path.join(base, 'tools');
    fs.mkdirSync(repo);
    fs.mkdirSync(toolsDir);
    git(repo, 'init', '-q', '-b', 'master');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    const copy = path.join(base, 'merged-copy');
    const moved = path.join(base, 'moved-copy');
    git(repo, 'worktree', 'add', '-q', '-b', 'merged-copy', copy);
    const aged = new Date(Date.now() - 7200000);
    fs.utimesSync(copy, aged, aged);
    const privateDir = git(copy, 'rev-parse', '--absolute-git-dir');
    const expected = [[path.join(privateDir, 'locked'), 7200], [path.join(privateDir, 'index.lock'), 10800], [path.join(repo, '.git', 'packed-refs.lock'), 14400]];
    const removeAttempt = path.join(base, 'remove-attempt');
    fs.writeFileSync(path.join(toolsDir, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args[0] === 'worktree' && args[1] === 'remove') {
  fs.writeFileSync(${JSON.stringify(removeAttempt)}, 'attempted');
  const held = spawnSync(${JSON.stringify(realGit)}, ['worktree', 'lock', '--reason', 'held during cleanup', ${JSON.stringify(copy)}], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8' });
  if (held.status !== 0) { process.stderr.write(held.stderr); process.exit(1); }
  for (const [file, seconds] of ${JSON.stringify(expected)}) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'fixture lock\\n');
    const aged = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(file, aged, aged);
  }
  if (${moves}) fs.renameSync(${JSON.stringify(copy)}, ${JSON.stringify(moved)});
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd, encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });

    const result = spawnSync(process.execPath, [cli, 'worktree', 'cleanup', '--apply', '--base', 'master'], {
      cwd: repo, env: { ...env, PATH: toolsDir + path.delimiter + env.PATH }, encoding: 'utf8', timeout: 60000,
    });
    console.log(`case: ${mode}`);
    console.log('command: node bin/atris.js worktree cleanup --apply --base master');
    console.log(result.stdout.trim());
    if (result.stderr.trim()) console.log(result.stderr.trim());
    console.log(`cli exit: ${result.status}`);
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(removeAttempt), true, 'cleanup never asked Git to remove the copy');
    assert.match(result.stdout, /^removeds: 0$/m, result.stdout);
    const line = result.stdout.split('\n').find((l) => l.startsWith(`kept: ${copy} reason=remove_failed git refused: `));
    assert.ok(line, result.stdout);
    assert.ok(line.includes(moves ? '; folder is missing; git lock: ' : '; git locks: '), line);
    for (const [file, seconds] of expected) {
      const age = line.split(`${file} (`)[1]?.match(/^(\d+)s old\)/);
      assert.ok(age && Math.abs(Number(age[1]) - seconds) <= 10, line);
      assert.ok(fs.existsSync(file));
    }
    assert.equal(fs.existsSync(copy), !moves);
    assert.equal(fs.readFileSync(path.join(moves ? moved : copy, 'README.md'), 'utf8'), '# fixture\n');
    assert.ok(git(repo, 'worktree', 'list', '--porcelain').includes(`worktree ${copy}\n`));
    git(repo, 'rev-parse', '--verify', 'refs/heads/merged-copy');
    assert.equal(fs.existsSync(path.join(repo, '.atris/state/worktree_removals.jsonl')), false);
  }
  console.log('Git refusal named three locks and distinct ages, in place and after the copy moved; files, branch, locks, and Git record retained; no removal recorded');
}

if (require.main === module) main();
