'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pick-live-home-'));
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const test = require('node:test');
const assert = require('node:assert');
const { pickLiveLocalMission } = require('../commands/mission');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pick-live-mission-'));
}

function writeMissions(root, lines) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), lines, 'utf8');
}

function mission(fields) {
  return {
    id: 'mission-live',
    status: 'running',
    objective: 'ship the gate',
    verifier: 'node -e "process.exit(0)"',
    cloud: false,
    created_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-02T00:00:00.000Z',
    ...fields,
  };
}

test('pickLiveLocalMission returns the running local mission', () => {
  const root = makeRoot();
  const live = mission({});
  writeMissions(root, `${JSON.stringify(live)}\n`);
  try {
    assert.deepStrictEqual(pickLiveLocalMission(root), live);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pickLiveLocalMission skips newer parked and cloud rows', () => {
  const root = makeRoot();
  const older = mission({
    id: 'mission-older',
    objective: 'older local card',
    updated_at: '2020-01-02T00:00:00.000Z',
  });
  const live = mission({
    id: 'mission-local',
    objective: 'newer local card',
    updated_at: '2020-01-03T00:00:00.000Z',
  });
  const lines = [
    older,
    live,
    mission({
      id: 'mission-cloud',
      objective: 'cloud card',
      cloud: true,
      updated_at: '2020-01-04T00:00:00.000Z',
    }),
    mission({
      id: 'mission-ready',
      status: 'ready',
      objective: 'parked card',
      updated_at: '2020-01-05T00:00:00.000Z',
    }),
    mission({
      id: 'mission-paused',
      status: 'paused',
      objective: 'paused card',
      updated_at: '2020-01-06T00:00:00.000Z',
    }),
    mission({
      id: 'mission-blocked',
      status: 'blocked',
      objective: 'blocked card',
      updated_at: '2020-01-07T00:00:00.000Z',
    }),
    mission({
      id: 'mission-done',
      status: 'complete',
      objective: 'finished card',
      updated_at: '2020-01-08T00:00:00.000Z',
    }),
    mission({
      id: 'mission-stopped',
      status: 'stopped',
      objective: 'stopped card',
      updated_at: '2020-01-09T00:00:00.000Z',
    }),
  ].map((row) => JSON.stringify(row)).join('\n');
  writeMissions(root, `${lines}\n`);
  try {
    const picked = pickLiveLocalMission(root);
    assert.strictEqual(picked.id, 'mission-local');
    assert.strictEqual(picked.status, 'running');
    assert.strictEqual(picked.cloud, false);
    assert.notStrictEqual(picked.id, older.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pickLiveLocalMission returns null when the ledger is missing or unusable', () => {
  const missing = makeRoot();
  const broken = makeRoot();
  try {
    assert.strictEqual(pickLiveLocalMission(missing), null);
    writeMissions(broken, '{not json\n{"status":"running","objective":"no id"}\n\n');
    assert.doesNotThrow(() => pickLiveLocalMission(broken));
    assert.strictEqual(pickLiveLocalMission(broken), null);
    writeMissions(broken, '');
    assert.strictEqual(pickLiveLocalMission(broken), null);
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});
