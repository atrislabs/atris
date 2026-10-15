'use strict';

// Disposable real-Git reproduction. No user folders are passed to disposal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareReviewSandbox, disposeReviewSandbox } = require('../../lib/fleet');

function main() {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(realGit.status, 0, realGit.stderr);
  const git = realGit.stdout.trim();
  for (const latePin of [false, true]) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-pin-')));
    const previousPath = process.env.PATH;
    let boundary;
    function run(args) {
      const result = spawnSync(git, args, { cwd: base, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    try {
      const repo = path.join(base, 'trusted');
      const origin = path.join(base, 'origin.git');
      run(['init', '-q', '-b', 'master', repo]);
      fs.writeFileSync(path.join(repo, 'proof.txt'), 'trusted content\n');
      run(['-C', repo, 'add', 'proof.txt']);
      run(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
      run(['clone', '-q', '--bare', repo, origin]);
      run(['-C', repo, 'remote', 'add', 'origin', origin]);
      const trustedHead = run(['-C', repo, 'rev-parse', 'HEAD']);
      boundary = prepareReviewSandbox({ root: repo, taskId: 'review-pin-probe', engine: 'codex' });
      assert.equal(boundary.ok, true, boundary.detail);
      const { worktreePath: copy, gitDir, quarantine, sandboxRoot } = boundary;
      assert.notEqual(gitDir, path.join(repo, '.git'));
      assert.equal(fs.readFileSync(path.join(copy, 'proof.txt'), 'utf8'), 'trusted content\n');
      assert.equal(run(['--git-dir', quarantine, 'rev-parse', 'refs/heads/master']), trustedHead);
      const bin = path.join(base, 'bin');
      const attempt = path.join(base, 'attempt.json');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const git = ${JSON.stringify(git)};
if (args.includes('worktree') && args.includes('remove')) {
  if (${latePin}) {
    const pin = spawnSync(git, ['--git-dir', ${JSON.stringify(gitDir)}, 'worktree', 'lock', '--reason', 'review still writing', ${JSON.stringify(copy)}], { encoding: 'utf8' });
    if (pin.status !== 0) { process.stderr.write(pin.stderr); process.exit(1); }
  }
  const removed = spawnSync(git, args, { encoding: 'utf8' });
  fs.writeFileSync(${JSON.stringify(attempt)}, JSON.stringify({ status: removed.status, stderr: removed.stderr }));
  process.stderr.write(removed.stderr);
  process.exit(removed.status === null ? 1 : removed.status);
}
const result = spawnSync(git, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      const result = disposeReviewSandbox(boundary);
      const removal = JSON.parse(fs.readFileSync(attempt, 'utf8'));
      const remaining = Object.fromEntries(Object.entries({ copy, gitDir, quarantine, sandboxRoot })
        .map(([key, value]) => [key, fs.existsSync(value)]));
      const log = path.join(repo, '.atris', 'state', 'worktree_removals.jsonl');
      const records = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.equal(records[0].path, copy);
      assert.equal(records[0].reason, 'review_sandbox_imported');
      assert.equal(run(['-C', repo, 'rev-parse', 'HEAD']), trustedHead);
      assert.equal(run(['--git-dir', origin, 'rev-parse', 'refs/heads/master']), trustedHead);
      assert.equal(fs.readFileSync(path.join(repo, 'proof.txt'), 'utf8'), 'trusted content\n');
      // Exit 0 diagnoses current behavior. It does not certify safe cleanup.
      assert.deepEqual(result, { removed: true });
      assert.ok(Object.values(remaining).every((exists) => exists === false));
      if (latePin) {
        assert.notEqual(removal.status, 0);
        assert.match(removal.stderr, /locked/);
      } else {
        assert.equal(removal.status, 0, removal.stderr);
      }
      console.log(JSON.stringify({ latePin, gitRemoval: removal, disposal: result, remaining,
        removalRecords: records.length, trustedProjectUnchanged: true }, null, 2));
      console.log(latePin
        ? 'confirmed: git refused the pin, all review paths were deleted, and cleanup recorded success'
        : 'control: git removed the idle copy, cleanup cleared its stores and recorded success');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      // Both locations were created by this invocation, never supplied by a user.
      if (boundary && boundary.ok) fs.rmSync(boundary.sandboxRoot, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
}

if (require.main === module) main();
