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
function installedPackageFixture(t, { failure = null, runResult = failure, writeArtifact = true, noisy = false, afterResult = null } = {}) {
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
      result = { decision: 'run', receipt_path: 'wake-only.json', checks: { has_mission: true, has_goal: true } };
    }
    if (argv[0] === 'member' && argv[1] === 'run') {
      const receipt_path = 'dispatch-proof.json';
      if (${JSON.stringify(writeArtifact)}) fs.writeFileSync(receipt_path, JSON.stringify({ cwd: process.cwd(), argv }));
      result = { ok: true, receipt_path, summary: 'packaged dispatch completed' };
      if (${JSON.stringify(runResult)}) result = ${JSON.stringify(runResult)};
      if (${JSON.stringify(noisy)}) process.stdout.write('starting work' + String.fromCharCode(10));
    }
    process.stdout.write(JSON.stringify(result, null, 2));
    if (${JSON.stringify(noisy)} && argv[1] === 'run') process.stdout.write(String.fromCharCode(10) + JSON.stringify({ ok: true, summary: 'cleanup done' }));
    if (${JSON.stringify(afterResult)} && argv[1] === 'run') process.stdout.write(String.fromCharCode(10) + JSON.stringify(${JSON.stringify(afterResult)}, null, 2));
  `);
  return {
    workspace,
    run({ sharedCheckout = false, command = false, expectedOk = true } = {}) {
      const env = { ...process.env };
      delete env.ATRIS_BIN;
      let args = ['-e', `
        const { runAliveTick } = require(${JSON.stringify(path.join(packageRoot, 'lib/member-alive.js'))});
        console.log(JSON.stringify(runAliveTick('demo', {
          cwd: ${JSON.stringify(workspace)}, execute: true, confirmed: true, noPrime: true,
          sharedCheckout: ${JSON.stringify(sharedCheckout)},
        })));
      `];
      if (command) {
        const home = path.join(workspace, 'atris', 'team', 'demo');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'MEMBER.md'), '# Demo\n');
        env.ATRIS_BIN = bin;
        env.HOME = root;
        env.ATRIS_SKIP_UPDATE_CHECK = '1';
        args = [path.join(__dirname, '..', 'bin', 'atris.js'), 'member', 'alive', 'demo',
          '--ticks', '1', '--execute', '--confirm-autonomy-policy', '--json',
          ...(sharedCheckout ? ['--shared-checkout'] : [])];
      }
      const result = spawnSync(process.execPath, args, { cwd: command ? workspace : root, env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const tick = JSON.parse(result.stdout);
      assert.equal(tick.ok, expectedOk, JSON.stringify(tick));
      return tick;
    },
  };
}

test('mission creation alone is planned and never borrows a wake receipt', (t) => {
  const fixture = installedPackageFixture(t, {
    runResult: { ok: true, action: 'mission_started', mission: { id: 'demo-mission' } },
    writeArtifact: false,
  });
  const tick = fixture.run();
  assert.equal(tick.status, 'planned');
  assert.equal(tick.reason, 'mission_started');
  assert.equal(tick.operate.payload.executed, false);
  assert.equal(tick.receipt_path, null);
  assert.equal(fs.existsSync(path.join(fixture.workspace, 'dispatch-proof.json')), false);
  const loop = fixture.run({ command: true });
  assert.equal(loop.status, 'planned');
  assert.deepEqual(loop.tick_receipts, []);
  const logged = JSON.parse(fs.readFileSync(loop.log_path, 'utf8').trim());
  assert.equal(logged.productive, false);
  assert.equal(logged.executed, false);
});

test('a real execution result after mission creation still completes with its own receipt', (t) => {
  const fixture = installedPackageFixture(t, {
    runResult: { ok: true, action: 'mission_started', mission: { id: 'demo-mission' } },
    afterResult: { ok: true, action: 'mission_run', ran_ticks: 1, receipt_path: 'dispatch-proof.json' },
  });
  const tick = fixture.run();
  assert.equal(tick.status, 'completed');
  assert.equal(tick.operate.payload.executed, true);
  assert.equal(tick.receipt_path, 'dispatch-proof.json');
});

test('outer mission success with an errored work tick is a failed unproductive run', (t) => {
  const fixture = installedPackageFixture(t, {
    runResult: {
      ok: true, action: 'mission_run', ran_ticks: 0,
      mission: { last_tick_status: 'errored' },
      receipt_path: 'failed-work.json',
      ticks: [{ status: 'errored', reason: 'claude-error', ran: false,
        claude: { ok: false, summary: 'API Error: 400 thinking type unsupported' } }],
    },
    writeArtifact: false,
  });
  const tick = fixture.run({ expectedOk: false });
  assert.equal(tick.status, 'failed');
  assert.equal(tick.operate.payload.reason, 'claude-error');
  assert.match(tick.operate.payload.detail, /API Error: 400/);
  const loop = fixture.run({ command: true, expectedOk: false });
  assert.equal(loop.status, 'failed');
  const logged = JSON.parse(fs.readFileSync(loop.log_path, 'utf8').trim());
  assert.equal(logged.productive, false);
});

for (const noisy of [false, true]) {
  test(`packaged dispatcher reports pretty JSON failure despite zero exit${noisy ? ' and later success' : ''}`, (t) => {
    const failure = { ok: false, reason: 'mission_error', detail: 'cannot create "/.agent-worktrees/workspace" {ENOENT}' };
    const fixture = installedPackageFixture(t, { failure, noisy });
    const tick = fixture.run({ expectedOk: false });
    assert.equal(tick.status, 'failed');
    assert.equal(tick.operate.status, 1);
    assert.equal(tick.operate.payload.exit_code, 0);
    assert.equal(tick.operate.payload.reason, failure.reason);
    assert.equal(tick.operate.payload.detail, failure.detail);
  });
}

test('member alive forwards explicit shared checkout through the packaged dispatcher', (t) => {
  const fixture = installedPackageFixture(t);
  fixture.run({ command: true, sharedCheckout: true });
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'dispatch-proof.json'), 'utf8'));
  assert.equal(receipt.argv.at(-1), '--shared-checkout');
  assert.equal(fs.realpathSync(receipt.cwd), fs.realpathSync(fixture.workspace));
});

test('member alive leaves checkout isolation unchanged by default', (t) => {
  const fixture = installedPackageFixture(t);
  fixture.run({ command: true });
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'dispatch-proof.json'), 'utf8'));
  assert.equal(receipt.argv.includes('--shared-checkout'), false);
});

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
