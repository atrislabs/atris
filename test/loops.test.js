const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function makeHeartbeatFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-'));
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
    jobs: [
      { id: 'demo-loop', purpose: 'demo purpose line', command: 'true', cadence_minutes: 15, enabled: true },
      { id: 'retired-loop', purpose: 'old', command: 'true', cadence_minutes: 15, enabled: false },
    ],
  }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    'demo-loop': { last_run: new Date(Date.now() - 5 * 60000).toISOString(), consecutive_fails: 3 },
  }));
  return dir;
}

function runLoops(args, dir) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'loops', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ATRIS_HEARTBEAT_DIR: dir, NODE_NO_WARNINGS: '1' },
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-cwd-')),
  });
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    cwd,
  });
}

test('loops board shows registry jobs with health and retired count', () => {
  const dir = makeHeartbeatFixture();
  const res = runLoops(['board'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /heartbeat registry \(1 live, 1 retired\)/);
  assert.match(res.stdout, /demo-loop/);
  assert.match(res.stdout, /3 consecutive fails/);
  assert.match(res.stdout, /demo purpose line/);
  assert.match(res.stdout, /atris loops stop <id>/);
});

test('loops stop disables a registry job with a backup', () => {
  const dir = makeHeartbeatFixture();
  const res = runLoops(['stop', 'demo-loop'], dir);
  assert.equal(res.status, 0, res.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  const job = registry.jobs.find(row => row.id === 'demo-loop');
  assert.equal(job.enabled, false);
  assert.equal(job.disabled, true);
  assert.ok(fs.existsSync(path.join(dir, 'registry.json.bak')));

  const restart = runLoops(['start', 'demo-loop'], dir);
  assert.equal(restart.status, 0, restart.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
  assert.equal(after.jobs.find(row => row.id === 'demo-loop').enabled, true);
});

test('loops stop rejects unknown ids', () => {
  const dir = makeHeartbeatFixture();
  const res = runLoops(['stop', 'nope'], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No registry job named "nope"/);
});

test('loops init scaffolds project loop files idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-project-'));
  const res = runCli(['loops', 'init'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /created:/);
  assert.match(res.stdout, /atris\/loops\/LOOPS\.md/);
  assert.match(res.stdout, /atris\/loops\/feedback\.md/);
  assert.match(res.stdout, /atris\/wiki\/systems\/loops\.md/);
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'loops', 'TICK.md')), true);

  const again = runCli(['loops', 'init'], dir);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /created:\n  none/);
  assert.match(again.stdout, /skipped:/);
  assert.match(again.stdout, /atris\/loops\/quality\.md/);
});

test('self-improve aliases loops init', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-self-improve-'));
  const res = runCli(['self-improve'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atris loops init/);
  assert.equal(fs.existsSync(path.join(dir, 'atris', 'loops', 'feedback.md')), true);
});

test('loops audit checks structural contract and optional Check command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-audit-'));
  assert.equal(runCli(['loops', 'init'], dir).status, 0);

  const res = runCli(['loops', 'audit'], dir);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /❌ feedback/);
  assert.match(res.stdout, /owner team\/TODO-feedback-owner does not exist/);
  assert.match(res.stdout, /check: `true` exit 0/);
  assert.match(res.stdout, /SELF-IMPROVING: NOT YET/);
});

test('loops tick prints project tick protocol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-tick-'));
  assert.equal(runCli(['loops', 'init'], dir).status, 0);

  const res = runCli(['loops', 'tick'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /# The Tick - loop protocol for ANY model/);
  assert.match(res.stdout, /atris loops audit/);
});
