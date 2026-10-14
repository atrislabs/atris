'use strict';

// Exercise the production cleanup routine with a real Git repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function main() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) delete process.env[name];
  }
  const { regressionCheck } = require('../../commands/autopilot');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-regression-check-')));
  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const hash = git('rev-parse', 'HEAD');
  const folder = path.join(repo, '.regression-worktree-' + hash.slice(0, 8));
  const registry = path.join(repo, 'atris', 'tick-registry.json');
  fs.mkdirSync(path.dirname(registry));
  function run(verifyCmd) {
    fs.writeFileSync(registry, JSON.stringify([{ hash, verifyCmd, slug: 'folder-check' }]));
    const [result] = regressionCheck(repo);
    console.log(JSON.stringify(result));
    assert.equal(result.pass, true);
    return result;
  }
  console.log(`fixture: ${repo}`);
  assert.equal(run('node -e "process.exit(0)"').cleanup.removed, true);
  assert.equal(fs.existsSync(folder), false);
  const removalFile = path.join(repo, '.atris/state/worktree_removals.jsonl');
  const removal = JSON.parse(fs.readFileSync(removalFile, 'utf8'));
  assert.equal(removal.path, folder);
  assert.equal(removal.by, 'atris autopilot');
  console.log(`removal recorded: ${removalFile}`);
  const source = String.raw`const fs = require('fs');
    const { execFileSync } = require('child_process');
    const dir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
    const lock = require('path').join(dir, 'index.lock');
    fs.writeFileSync(lock, 'unfinished git work');
    const aged = new Date(Date.now() - 7200000); fs.utimesSync(lock, aged, aged);`;
  const kept = run(`node -e '${source.replace(/'/g, "'\\''")}'`);
  assert.equal(kept.cleanup.removed, false);
  assert.match(kept.cleanup.reason, /index\.lock \(720\d+s old\)/);
  assert.ok(fs.existsSync(folder));
  assert.equal(fs.readFileSync(removalFile, 'utf8').trim().split('\n').length, 1);
  console.log('clean folder removed and logged; locked folder retained with its exact lock path and age');

  // A forwarding git adds an aged keep marker, or ordinary private and shared
  // locks, while cleanup runs its safety check.
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const toolsDir = path.join(repo, '.atris', 'tools');
  const removeAttempt = path.join(repo, '.atris', 'remove-attempt');
  fs.mkdirSync(toolsDir, { recursive: true });
  for (const kind of ['after', 'gone', 'marker', 'ordinary', 'vanished', 'refused']) {
    const vanishes = !['marker', 'ordinary', 'refused'].includes(kind);
    fs.writeFileSync(path.join(repo, `late-${kind}.txt`), `late ${kind} case\n`);
    git('add', '.');
    git('commit', '-qm', `late ${kind} case`);
    const lateHash = git('rev-parse', 'HEAD');
    const lateFolder = path.join(repo, '.regression-worktree-' + lateHash.slice(0, 8));
    const privateDir = path.join(repo, '.git', 'worktrees', path.basename(lateFolder).replace(/^\./, '-'));
    const moved = path.join(repo, '.atris', `moved-${kind}`);
    const expected = kind === 'gone' || kind === 'after' ? []
      : kind === 'refused' ? [[path.join(privateDir, 'locked'), 7200], [path.join(privateDir, 'index.lock'), 10800], [path.join(repo, '.git', 'packed-refs.lock'), 14400]]
      : kind === 'marker' ? [[path.join(privateDir, 'locked'), 10800]]
      : [[path.join(privateDir, 'index.lock'), 10800], [path.join(repo, '.git', 'packed-refs.lock'), 14400]];
    // Clear only the previous case's shared fixture lock so this check passes
    // before the forwarding Git creates fresh locks at removal.
    if (kind === 'refused') fs.unlinkSync(path.join(repo, '.git', 'packed-refs.lock'));
    fs.writeFileSync(path.join(toolsDir, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args[0] === 'worktree' && args[1] === 'remove') fs.writeFileSync(${JSON.stringify(removeAttempt)}, 'attempted');
if (${kind === 'refused'}
  ? args[0] === 'worktree' && args[1] === 'remove'
  : args.includes('--git-dir') && args.includes('--git-common-dir') && cwd === ${JSON.stringify(lateFolder)}) {
  if (${kind === 'marker' || kind === 'refused'}) {
    const held = spawnSync(${JSON.stringify(realGit)}, ['worktree', 'lock', '--reason', 'held during cleanup', ${JSON.stringify(lateFolder)}], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8' });
    if (held.status !== 0) { process.stderr.write(held.stderr); process.exit(1); }
  }
  for (const [file, seconds] of ${JSON.stringify(expected)}) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'fixture lock\\n');
    const aged = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(file, aged, aged);
  }
  if (${vanishes && kind !== 'after'}) fs.renameSync(${JSON.stringify(lateFolder)}, ${JSON.stringify(moved)});
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd, stdio: 'inherit' });
if (${kind === 'after'} && args.includes('--git-common-dir') && cwd === ${JSON.stringify(lateFolder)}) fs.renameSync(${JSON.stringify(lateFolder)}, ${JSON.stringify(moved)});
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${toolsDir}${path.delimiter}${savedPath}`;
    let late;
    try {
      fs.writeFileSync(registry, JSON.stringify([{ hash: lateHash, verifyCmd: 'node -e "process.exit(0)"', slug: `late-${kind}` }]));
      [late] = regressionCheck(repo);
    } finally {
      process.env.PATH = savedPath;
    }
    console.log(JSON.stringify(late));
    const present = vanishes ? moved : lateFolder;
    assert.equal(fs.existsSync(lateFolder), !vanishes);
    assert.equal(git('-C', present, 'rev-parse', '--absolute-git-dir'), privateDir);
    assert.equal(late.pass, true);
    assert.equal(late.cleanup.removed, false);
    if (kind === 'gone' || kind === 'after') assert.equal(late.cleanup.reason, 'folder is missing');
    if (kind === 'after' || kind === 'refused') assert.ok(git('worktree', 'list', '--porcelain').includes(`worktree ${lateFolder}\n`));
    if (kind === 'vanished') assert.ok(late.cleanup.reason.startsWith('folder is missing; git lock: '), late.cleanup.reason);
    for (const [file, seconds] of expected) {
      const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reported = late.cleanup.reason.match(new RegExp(`${escaped} \\((\\d+)s old\\)`));
      assert.ok(reported, late.cleanup.reason);
      assert.ok(Math.abs(Number(reported[1]) - seconds) <= 10, late.cleanup.reason);
      assert.ok(fs.existsSync(file));
    }
    assert.ok(fs.existsSync(path.join(present, `late-${kind}.txt`)));
    assert.equal(fs.existsSync(removeAttempt), kind === 'refused');
    assert.equal(fs.readFileSync(removalFile, 'utf8').trim().split('\n').length, 1);
  }
  console.log('Git refusal after a passing check named three locks and distinct ages; files and Git record retained; no removal recorded');
  console.log('a folder that disappeared after a passing safety check was reported missing, kept in Git, and no removal was attempted or recorded');
  console.log('a folder that disappeared during the safety check with no lock left was reported only as missing, and no removal was attempted');
  console.log('late keep marker during the safety check kept the folder, named the marker and its age, and no removal was attempted');
  console.log('late private and shared locks during the safety check kept the folder, named both paths with distinct ages, and no removal was attempted');
  console.log('a folder that disappeared during the safety check was reported missing with both retained lock paths and ages, and no removal was attempted');
}

if (require.main === module) main();
