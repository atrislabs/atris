// Run the real cleanup preview against a disposable repository with a held lock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function main() {
  const root = path.resolve(__dirname, '../..');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-folder-report-')));
  const repo = path.join(base, 'repo');
  const copy = path.join(base, 'copy');
  function git(args) {
    const result = spawnSync('git', args, { cwd: base, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  try {
    git(['init', '-q', '-b', 'master', repo]);
    git(['-C', repo, '-c', 'user.name=Proof', '-c', 'user.email=proof@example.com', 'commit', '--allow-empty', '-qm', 'fixture']);
    git(['-C', repo, 'worktree', 'add', '-qb', 'copy', copy]);
    const dir = git(['-C', copy, 'rev-parse', '--absolute-git-dir']);
    const lock = path.join(dir, 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const args = [path.join(root, 'bin/atris.js'), 'worktree', 'cleanup', '--base', 'HEAD'];
    const result = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
    console.log('command: node bin/atris.js worktree cleanup --base HEAD (fixture cwd)');
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.log(`exit: ${result.status}`);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(`held: ${copy} git holds ${lock}, 3 h old`));
    assert.ok(fs.existsSync(copy));
    console.log('locked folder remains: yes');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (require.main === module) main();
