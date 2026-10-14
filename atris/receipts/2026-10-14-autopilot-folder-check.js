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
}

if (require.main === module) main();
