const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  shortRecordLabel,
  shortRecordRef,
} = require('../lib/short-name');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-short-names-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function prepareWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function wishesPath(dir) {
  return path.join(dir, '.atris', 'state', 'wishes.jsonl');
}

function missionsPath(dir) {
  return path.join(dir, '.atris', 'state', 'missions.jsonl');
}

test('short labels use display numbers and meaningful words with old-record fallback', () => {
  const oldId = 'wish-2026-07-06-claim-orb-loop-testable-on-haiku-via-8429e7cd';
  assert.equal(shortRecordLabel({ id: oldId, n: 7 }, 'claim the haiku loop via'), '#7 haiku loop');
  assert.equal(shortRecordRef({ id: oldId, n: 7 }), '7');
  assert.equal(shortRecordLabel({ id: oldId }, 'claim the haiku loop via smoke'), '8429e7cd');
  assert.equal(shortRecordRef({ id: oldId }), '8429e7cd');
});

test('wish capture assigns the next display number from wishes jsonl', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendJsonl(wishesPath(dir), {
      id: 'wish-old-no-number',
      ts: '2026-07-06T09:00:00.000Z',
      text: 'old missing number',
      status: 'complete',
    });
    appendJsonl(wishesPath(dir), {
      id: 'wish-old-numbered',
      n: 6,
      ts: '2026-07-06T10:00:00.000Z',
      text: 'old numbered wish',
      status: 'complete',
    });

    const res = runCli(['wish', 'claim the haiku loop', '--no-mission'], {
      cwd: dir,
      env: { PATH: systemPath },
    });
    assert.notEqual(res.status, 2, res.stderr || res.stdout);

    const records = readJsonl(wishesPath(dir));
    const captured = records.find((record) => record.text === 'claim the haiku loop' && record.status === 'captured');
    assert.ok(captured, 'captured wish record exists');
    assert.equal(captured.n, 7);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wish display uses short labels and review accepts a bare display number', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendJsonl(wishesPath(dir), {
      id: 'wish-2026-07-06-claim-haiku-loop-11111111',
      n: 7,
      ts: '2026-07-06T10:00:00.000Z',
      text: 'claim the haiku loop',
      status: 'delegated',
      dispatched_at: '2026-07-06T10:00:00.000Z',
    });
    appendJsonl(wishesPath(dir), {
      id: 'wish-2026-07-06-claim-orb-loop-22222222',
      n: 8,
      ts: '2026-07-06T11:00:00.000Z',
      text: 'claim the orb loop',
      status: 'complete',
      completed_at: '2026-07-06T11:00:00.000Z',
    });

    const list = runCli(['wish', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /1\. #7 haiku loop - in flight/);
    assert.match(list.stdout, /2\. #8 orb loop - came true/);
    assert.doesNotMatch(list.stdout, /wish-2026-07-06/);

    const nudge = runCli(['wish'], { cwd: dir });
    assert.equal(nudge.status, 2);
    assert.match(nudge.stdout, /#8 orb loop: atris wish review 8 "<one sentence>"/);
    assert.doesNotMatch(nudge.stdout, /wish-2026-07-06-claim-orb-loop/);

    const reviewed = runCli(['wish', 'review', '7', 'Useful but too broad.'], {
      cwd: dir,
      env: { ATRIS_AGENT_ID: 'tester' },
    });
    assert.equal(reviewed.status, 0, reviewed.stderr || reviewed.stdout);
    const records = readJsonl(wishesPath(dir));
    assert.equal(records.at(-1).kind, 'review');
    assert.equal(records.at(-1).wish_id, 'wish-2026-07-06-claim-haiku-loop-11111111');
    assert.equal(records.at(-1).review_text, 'Useful but too broad.');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start assigns the next display number from missions jsonl', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    appendJsonl(missionsPath(dir), {
      schema: 'atris.mission.v1',
      id: 'mission-old-no-number',
      objective: 'old missing number',
      owner: 'mission-lead',
      status: 'complete',
      created_at: '2026-07-06T09:00:00.000Z',
      updated_at: '2026-07-06T09:00:00.000Z',
    });
    appendJsonl(missionsPath(dir), {
      schema: 'atris.mission.v1',
      id: 'mission-old-numbered',
      n: 4,
      objective: 'old numbered mission',
      owner: 'mission-lead',
      status: 'complete',
      created_at: '2026-07-06T10:00:00.000Z',
      updated_at: '2026-07-06T10:00:00.000Z',
    });

    const started = runCli(['mission', 'start', '--no-verify', 'claim the haiku loop', '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const payload = JSON.parse(started.stdout);
    assert.equal(payload.mission.n, 5);

    const records = readJsonl(missionsPath(dir));
    assert.equal(records.at(-1).id, payload.mission.id);
    assert.equal(records.at(-1).n, 5);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission status uses short labels and accepts a bare display number', () => {
  const dir = makeTempDir();
  try {
    prepareWorkspace(dir);
    const started = runCli(['mission', 'start', '--no-verify', 'claim the haiku loop', '--owner', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const status = runCli(['mission', 'status', String(mission.n)], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, new RegExp(`Mission: #${mission.n} haiku loop`));
    assert.match(status.stdout, /objective: claim the haiku loop/);
    assert.doesNotMatch(status.stdout, new RegExp(mission.id));
  } finally {
    cleanupTempDir(dir);
  }
});
