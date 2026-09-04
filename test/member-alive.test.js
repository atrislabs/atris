'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { runAliveTick } = require('../lib/member-alive');

test('alive dry-run plans without execute', () => {
  const tick = runAliveTick('__missing_member__', { execute: false, confirmed: false });
  assert.equal(tick.mode, 'dry_run');
  assert.equal(tick.operate.skipped, true);
  assert.equal(tick.auto_accept.skipped, true);
});

// Writes a fake `atris` CLI that returns a fixed `member wake` decision so we can assert how an
// execute tick reacts to the member's own judgment without spinning up real member state.
function writeFakeAtris(dir, wakeDecision) {
  const binPath = path.join(dir, 'fake-atris.js');
  const wakeJson = JSON.stringify(wakeDecision);
  fs.writeFileSync(binPath, [
    'const argv = process.argv.slice(2);',
    'const sub = `${argv[0]} ${argv[1]}`;',
    `if (sub === 'member wake') { process.stdout.write(${JSON.stringify(wakeJson)}); }`,
    "else { process.stdout.write(JSON.stringify({ ok: true, summary: { would_accept: 0 } })); }",
    'process.exit(0);',
  ].join('\n'), 'utf8');
  return binPath;
}

test('alive execute honors a wait decision and skips operate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-wait-'));
  try {
    const atrisBin = writeFakeAtris(dir, {
      decision: 'wait',
      reason: 'open_experiment_proposed',
      needs_user: false,
      next_command: 'atris member review demo exp-1 --accept --proof "..." --value 4',
      checks: { has_mission: true, has_goal: true },
    });
    const tick = runAliveTick('demo', { execute: true, confirmed: true, noPrime: true, atrisBin, cwd: dir });
    // The member said "wait" — we must NOT force a failing operate tick.
    assert.equal(tick.operate.skipped, true);
    assert.equal(tick.operate.reason, 'wake_wait');
    assert.equal(tick.status, 'waiting');
    assert.equal(tick.reason, 'open_experiment_proposed');
    assert.equal(tick.blocked_on_human, true);
    assert.match(tick.next_command, /member review/);
    assert.equal(tick.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('alive execute treats stop (no goal) as non-blocking idle, not failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-stop-'));
  try {
    const atrisBin = writeFakeAtris(dir, {
      decision: 'stop',
      reason: 'no_active_goal',
      needs_user: false,
      next_command: 'atris member goal-from-mission demo',
      checks: { has_mission: true, has_goal: false },
    });
    const tick = runAliveTick('demo', { execute: true, confirmed: true, noPrime: true, atrisBin, cwd: dir });
    assert.equal(tick.operate.skipped, true);
    assert.equal(tick.status, 'waiting');
    assert.equal(tick.blocked_on_human, false);
    assert.equal(tick.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Exercise the shipped library and dispatcher in an installed-package layout.
// Only the final CLI work is a fixture, so no model or user credentials are used.
function installedPackageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-installed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules', 'atris');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  for (const relative of ['lib/member-alive.js', 'scripts/member-operate.mjs']) {
    const destination = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', relative), destination);
  }
  const bin = path.join(packageRoot, 'bin', 'atris.js');
  fs.mkdirSync(path.dirname(bin));
  fs.writeFileSync(bin, `
    const fs = require('node:fs');
    const argv = process.argv.slice(2);
    let result = { ok: true };
    if (argv[0] === 'member' && argv[1] === 'wake') {
      result = { decision: 'run', checks: { has_mission: true, has_goal: true } };
    }
    if (argv[0] === 'member' && argv[1] === 'run') {
      const receipt_path = 'dispatch-proof.json';
      fs.writeFileSync(receipt_path, JSON.stringify({ cwd: process.cwd(), argv }));
      result = { ok: true, receipt_path, summary: 'packaged dispatch completed' };
    }
    process.stdout.write(JSON.stringify(result));
  `);
  return {
    workspace,
    run() {
      const env = { ...process.env };
      delete env.ATRIS_BIN;
      const result = spawnSync(process.execPath, ['-e', `
        const { runAliveTick } = require(${JSON.stringify(path.join(packageRoot, 'lib/member-alive.js'))});
        console.log(JSON.stringify(runAliveTick('demo', {
          cwd: ${JSON.stringify(workspace)}, execute: true, confirmed: true, noPrime: true,
        })));
      `], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const tick = JSON.parse(result.stdout);
      assert.equal(tick.ok, true, JSON.stringify(tick));
      return tick;
    },
  };
}

test('installed alive dispatches its packaged script with the workspace cwd', (t) => {
  const fixture = installedPackageFixture(t);
  assert.equal(fs.existsSync(path.join(fixture.workspace, 'scripts')), false);
  const tick = fixture.run();
  assert.equal(tick.operate.payload.executed, true);
  assert.equal(tick.operate.payload.summary, 'packaged dispatch completed');
  assert.equal(tick.receipt_path, 'dispatch-proof.json');
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.workspace, tick.receipt_path), 'utf8'));
  assert.equal(fs.realpathSync(receipt.cwd), fs.realpathSync(fixture.workspace));
  assert.deepEqual(receipt.argv, ['member', 'run', 'demo', '--json', '--max-wall', '900']);
});

for (const extension of ['mjs', 'js']) {
  test(`workspace ${extension} dispatcher takes precedence over the installed package`, (t) => {
    const fixture = installedPackageFixture(t);
    const scripts = path.join(fixture.workspace, 'scripts');
    fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, `member-operate.${extension}`), `
      console.log(JSON.stringify({ ok: true, summary: 'workspace ${extension}', cwd: process.cwd() }));
    `);
    if (extension === 'mjs') {
      fs.writeFileSync(path.join(scripts, 'member-operate.js'), "throw new Error('mjs must win');");
    }
    const tick = fixture.run();
    assert.equal(tick.operate.payload.summary, `workspace ${extension}`);
    assert.equal(fs.realpathSync(tick.operate.payload.cwd), fs.realpathSync(fixture.workspace));
    assert.equal(fs.existsSync(path.join(fixture.workspace, 'dispatch-proof.json')), false);
  });
}
