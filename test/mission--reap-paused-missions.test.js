'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reapPausedMissions } = require('../commands/mission');

const STALE_TS = '2000-01-01T00:00:00.000Z';

const savedEnv = {};
const tempDirs = [];

test.before(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    process.env[key] = value;
  }
});

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reap-paused-test-'));
  tempDirs.push(dir);
  return dir;
}

function missionsPath(root) {
  return path.join(root, '.atris', 'state', 'missions.jsonl');
}

function writeMission(root, mission) {
  const file = missionsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({
    schema: 'atris.mission.v1',
    objective: `objective for ${mission.id}`,
    owner: 'mission-lead',
    runner: 'manual',
    cadence: 'manual',
    lane: 'workspace',
    task_ids: [],
    human_asks: [],
    next_action: 'record the next tick',
    created_at: STALE_TS,
    updated_at: STALE_TS,
    ...mission,
  })}\n`, 'utf8');
}

function readMissions(root) {
  const file = missionsPath(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latestMission(root, id) {
  const rows = readMissions(root).filter((row) => row.id === id);
  return rows[rows.length - 1] || null;
}

test('reaps a paused mission idle past the window and stops it on disk', () => {
  const root = makeWorkspace();
  writeMission(root, { id: 'm-stale', status: 'paused', last_tick_at: STALE_TS });

  const expired = reapPausedMissions(root, { hours: 48 });

  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, 'm-stale');
  assert.strictEqual(expired[0].previous_status, 'paused');
  assert.deepStrictEqual(expired.held, []);

  const saved = latestMission(root, 'm-stale');
  assert.strictEqual(saved.status, 'stopped');
  assert.ok(saved.stop_reason.includes('expired after 48+ idle hours'));
  assert.ok(saved.stop_reason.includes('atris mission tick m-stale'));

  const eventsFile = path.join(root, '.atris', 'state', 'mission_events.jsonl');
  const events = fs.readFileSync(eventsFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'mission_expired' && event.mission_id === 'm-stale'));
});

test('leaves a recently paused mission and a stale non-paused mission alone', () => {
  const root = makeWorkspace();
  const freshTick = new Date(Date.now() - 60 * 1000).toISOString();
  writeMission(root, { id: 'm-fresh', status: 'paused', last_tick_at: freshTick });
  writeMission(root, { id: 'm-ready', status: 'ready', last_tick_at: STALE_TS });

  const expired = reapPausedMissions(root, { hours: 48 });

  assert.strictEqual(expired.length, 0);
  assert.strictEqual(latestMission(root, 'm-fresh').status, 'paused');
  assert.strictEqual(latestMission(root, 'm-ready').status, 'ready');
});

test('holds a stale paused mission whose pause needs a human', () => {
  const root = makeWorkspace();
  writeMission(root, {
    id: 'm-blocked',
    status: 'paused',
    last_tick_at: STALE_TS,
    stop_reason: 'auth-required',
  });

  const expired = reapPausedMissions(root, { hours: 48 });

  assert.strictEqual(expired.length, 0);
  assert.strictEqual(expired.held.length, 1);
  assert.strictEqual(expired.held[0].id, 'm-blocked');
  assert.strictEqual(expired.held[0].reason, 'auth-required');
  assert.ok(expired.held[0].resume_command.includes('atris mission run m-blocked'));
  assert.strictEqual(latestMission(root, 'm-blocked').status, 'paused');
});

test('dry run reports the reap without writing, empty workspace returns nothing', () => {
  const emptyRoot = makeWorkspace();
  assert.strictEqual(reapPausedMissions(emptyRoot, { hours: 48 }).length, 0);

  const root = makeWorkspace();
  writeMission(root, { id: 'm-dry', status: 'paused', last_tick_at: STALE_TS });

  const expired = reapPausedMissions(root, { hours: 48, dryRun: true });

  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, 'm-dry');
  assert.strictEqual(latestMission(root, 'm-dry').status, 'paused');
  assert.strictEqual(readMissions(root).length, 1);
});
