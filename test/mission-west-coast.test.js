const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'atris.js');
const { defaultMissionEffort, resolveMissionTickRunner, runMissionAudible } = require('../lib/mission-core');
const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-wc-'));
}

test('defaultMissionEffort routes by task shape and keeps explicit pins', () => {
  const bounded = { objective: 'Fix button copy' };
  assert.equal(defaultMissionEffort(bounded, 'claude'), 'low');
  assert.equal(defaultMissionEffort(bounded, 'codex'), 'low');
  for (const objective of ['Fix race condition in queue', 'Fix concurrency bug in lock', 'Run a security audit of login']) {
    assert.equal(defaultMissionEffort({ objective }, 'claude'), 'high', objective);
  }
  assert.equal(defaultMissionEffort({ objective: 'Fix race condition', roster_effort: 'LOW ' }, 'claude'), 'low');
  assert.equal(defaultMissionEffort({ objective: 'Fix button copy', effort: 'high' }, 'claude'), 'high');
  assert.equal(defaultMissionEffort(bounded, 'devin'), '');
  assert.equal(defaultMissionEffort(bounded, 'cursor'), '');
  assert.equal(defaultMissionEffort(bounded, ''), '');
});

test('resolveMissionTickRunner adds low effort to a bounded claude mission without overriding a pin', () => {
  const root = tempRoot();
  const plain = resolveMissionTickRunner({ id: 'm1', objective: 'Fix button copy', runner: 'claude' }, root, { explain: false });
  assert.equal(plain.mission.roster_effort, 'low');
  const pinned = resolveMissionTickRunner({ id: 'm2', objective: 'Fix button copy', runner: 'claude', roster_effort: 'high' }, root, { explain: false });
  assert.equal(pinned.mission.roster_effort, 'high');
});

test('runMissionAudible asks the diagnose worker with a read-only prompt', async () => {
  const calls = [];
  const ask = async (jobs) => {
    calls.push(jobs);
    return [{ ok: true, stdout: 'Root cause: missing await in save.' }];
  };
  // The repo's roster in a temp room with its engines marked ready, so the
  // worker does not depend on which engines this machine has installed.
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'atris'));
  fs.copyFileSync(path.join(REPO, 'atris', 'ROSTER.md'), path.join(root, 'atris', 'ROSTER.md'));
  readEngineRegistry(root);
  for (const name of ['claude', 'codex']) setEngineHealth(name, 'ready', root);
  const out = await runMissionAudible(root, {
    mission: { id: 'm3', objective: 'Make the save test pass' },
    verifierResult: { passed: false, stderr: 'AssertionError: expected saved', stdout: '' },
    ask,
  });
  assert.equal(calls.length, 1);
  const job = calls[0][0];
  assert.ok(['claude', 'codex', 'fable'].includes(job.engine), job.engine);
  assert.match(String(job.model), /fable 5\.2|fable-5-2|gpt-6\.2-astra/i);
  assert.equal(job.effort, 'high');
  assert.match(job.prompt, /Do NOT write code/);
  assert.match(job.prompt, /Make the save test pass/);
  assert.match(job.prompt, /AssertionError: expected saved/);
  assert.equal(out.ok, true);
  assert.match(out.diagnosis, /missing await/);
});

test('runMissionAudible never throws', async () => {
  const out = await runMissionAudible(REPO, { mission: { id: 'm4', objective: 'x' }, error: 'boom', ask: async () => { throw new Error('engine down'); } });
  assert.equal(out.ok, false);
  assert.equal(out.diagnosis, '');
});

test('mission start --effort persists the pin and rejects unknown levels', () => {
  const root = tempRoot();
  const env = { ...process.env, ATRIS_ROUTER_EXPLAIN: '0' };
  const ok = spawnSync(process.execPath, [CLI, 'mission', 'start', 'Fix button copy', '--effort', 'low', '--no-verify', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const payload = JSON.parse(ok.stdout);
  const mission = payload.mission || payload;
  assert.equal(mission.effort, 'low');
  assert.equal(mission.roster_effort, 'low');

  const bad = spawnSync(process.execPath, [CLI, 'mission', 'start', 'Fix button copy', '--effort', 'turbo', '--no-verify'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /Invalid --effort "turbo"\. Expected one of: .*low.*high/);
});
