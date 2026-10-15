'use strict';

// Disposable real-Git reproduction. No user folders are passed to disposal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function main() {
const { disposeReviewSandbox } = require('../../lib/fleet');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-pin-')));
const previousPath = process.env.PATH;
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' });
assert.equal(realGit.status, 0, realGit.stderr);
const git = realGit.stdout.trim();
function run(args) {
  const result = spawnSync(git, args, { cwd: base, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
try {
  const repo = path.join(base, 'repo');
  const copy = path.join(base, 'copy');
  run(['init', '-q', repo]);
  run(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  run(['-C', repo, 'worktree', 'add', '-q', '--detach', copy]);
  const boundary = {
    worktreePath: copy,
    gitDir: path.join(repo, '.git'),
    quarantine: path.join(base, 'quarantine.git'),
    sandboxRoot: path.join(base, 'review'),
  };
  fs.mkdirSync(boundary.quarantine);
  fs.mkdirSync(boundary.sandboxRoot);
  const bin = path.join(base, 'bin');
  const attempt = path.join(base, 'attempt.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const git = ${JSON.stringify(git)};
if (args.includes('worktree') && args.includes('remove')) {
  const pin = spawnSync(git, ['-C', ${JSON.stringify(repo)}, 'worktree', 'lock', '--reason', 'review still writing', ${JSON.stringify(copy)}], { encoding: 'utf8' });
  if (pin.status !== 0) { process.stderr.write(pin.stderr); process.exit(1); }
  const refused = spawnSync(git, args, { encoding: 'utf8' });
  fs.writeFileSync(${JSON.stringify(attempt)}, JSON.stringify({ status: refused.status, stderr: refused.stderr }));
  process.stderr.write(refused.stderr);
  process.exit(refused.status === null ? 1 : refused.status);
}
const result = spawnSync(git, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const result = disposeReviewSandbox(boundary);
  const refused = JSON.parse(fs.readFileSync(attempt, 'utf8'));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /locked/);
  const remaining = Object.fromEntries(Object.entries(boundary).map(([key, value]) => [key, fs.existsSync(value)]));
  console.log(JSON.stringify({ gitRefusal: refused, disposal: result, remaining }, null, 2));
  // This diagnostic proves the current defect, rather than claiming safety.
  assert.deepEqual(result, { removed: true });
  assert.ok(Object.values(remaining).every((exists) => exists === false));
  console.log('confirmed: a real git pin was refused, then all four disposable paths were deleted');
} finally {
  process.env.PATH = previousPath;
  fs.rmSync(base, { recursive: true, force: true });
}

}

if (require.main === module) main();
