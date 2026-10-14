'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

// A member kept working with `member loop --forever` must not keep running old code after
// atris is upgraded underneath it. The loop runs from a copied, installed-style package; the
// first tick upgrades that package's version on disk, like `npm install -g atris` would.
// Only the member's own work is a fixture, so no model or credentials are used.
test('a forever member loop restarts itself on the newly installed atris version', (t) => {
  const repo = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules', 'atris');
  for (const relative of ['bin', 'commands', 'lib', 'utils', 'package.json', 'scripts/member-operate.mjs']) {
    fs.cpSync(path.join(repo, relative), path.join(packageRoot, relative), { recursive: true });
  }
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const oldVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  const newVersion = `${oldVersion}-upgraded`;

  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'atris', 'team', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'atris', 'team', 'demo', 'MEMBER.md'), '# Demo\n');
  const stopPath = path.join(workspace, '.atris', 'state', 'member-loops', 'demo.stop.json');
  const countPath = path.join(root, 'wake-count');

  // First wake: install the new version. Second wake (the restarted loop): ask it to stop.
  const fakeAtris = path.join(root, 'fake-atris.js');
  fs.writeFileSync(fakeAtris, `
    const fs = require('node:fs');
    const argv = process.argv.slice(2);
    if (argv[0] === 'member' && argv[1] === 'wake') {
      const count = (fs.existsSync(${JSON.stringify(countPath)}) ? Number(fs.readFileSync(${JSON.stringify(countPath)}, 'utf8')) : 0) + 1;
      fs.writeFileSync(${JSON.stringify(countPath)}, String(count));
      if (count === 1) {
        const pkg = JSON.parse(fs.readFileSync(${JSON.stringify(packageJsonPath)}, 'utf8'));
        pkg.version = ${JSON.stringify(newVersion)};
        fs.writeFileSync(${JSON.stringify(packageJsonPath)}, JSON.stringify(pkg));
      } else {
        fs.writeFileSync(${JSON.stringify(stopPath)}, '{}');
      }
      process.stdout.write(JSON.stringify({ decision: 'wait', reason: 'nothing_to_do', checks: { has_mission: true, has_goal: true } }));
    } else {
      process.stdout.write(JSON.stringify({ ok: true, summary: { would_accept: 0 } }));
    }
  `);

  const env = { ...process.env, HOME: root, ATRIS_BIN: fakeAtris, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_MEMBER_LOOP_RESTARTED_FROM;
  const result = spawnSync(process.execPath, [
    path.join(packageRoot, 'bin', 'atris.js'), 'member', 'loop', 'demo',
    '--alive', '--forever', '--interval', '0', '--execute', '--confirm-autonomy-policy',
  ], { cwd: workspace, env, encoding: 'utf8', timeout: 60000 });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, new RegExp(`Upgrade: atris ${oldVersion} -> ${newVersion}, restarting on the new version`));
  assert.equal(fs.readFileSync(countPath, 'utf8'), '2', 'the restarted loop should run one more wake on the new version');

  // The last word belongs to the restarted loop: it knows where it came from, and it stopped cleanly.
  const latest = JSON.parse(fs.readFileSync(path.join(workspace, '.atris', 'state', 'member-loops', 'demo.latest.json'), 'utf8'));
  assert.equal(latest.status, 'stopped');
  assert.equal(latest.restarted_from_version, oldVersion);
  assert.equal(latest.upgrade, null);
  assert.equal(fs.existsSync(path.join(workspace, '.atris', 'state', 'member-loops', 'demo.lock.json')), false);
});
