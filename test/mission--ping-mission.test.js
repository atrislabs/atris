'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep this run off the machine: HOME points at a scratch dir and ATRIS_*
// vars are dropped, so nothing reads the real home folder or workspace settings.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ping-home-'));
process.env.HOME = scratchHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
after(() => fs.rmSync(scratchHome, { recursive: true, force: true }));

const { pingMission } = require('../commands/mission');

const MISSION_ID = 'mission-2026-10-20-ping-fixture-0a1b2c3d';

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

// pingMission exits through process.exit on bad input. Swap it for a throw so
// the test can read the exit code and the printed lines without dying.
function runCapturing(fn) {
  const realExit = process.exit;
  const realLog = console.log;
  const realError = console.error;
  const out = { code: null, logs: [], errors: [] };
  process.exit = (code) => {
    throw new ExitSignal(code);
  };
  console.log = (...args) => out.logs.push(args.join(' '));
  console.error = (...args) => out.errors.push(args.join(' '));
  try {
    fn();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    out.code = error.code;
  } finally {
    process.exit = realExit;
    console.log = realLog;
    console.error = realError;
  }
  return out;
}

// pingMission finds missions under process.cwd(), so each test runs inside
// its own scratch folder and puts the working directory back afterward.
function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ping-test-'));
  const before = process.cwd();
  process.chdir(root);
  try {
    return fn(root);
  } finally {
    process.chdir(before);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ledgerPath(root) {
  return path.join(root, '.atris', 'state', 'missions.jsonl');
}

function seedMission(root, overrides = {}) {
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  const mission = {
    schema: 'atris.mission.v1',
    id: MISSION_ID,
    objective: 'keep the lint lane green',
    status: 'running',
    runner: 'manual',
    cadence: 'manual',
    lane: 'workspace',
    task_ids: [],
    human_asks: [],
    pings: [],
    next_action: 'record the next tick',
    created_at: '2026-10-20T10:00:00.000Z',
    updated_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
  fs.appendFileSync(ledgerPath(root), `${JSON.stringify(mission)}\n`, 'utf8');
  return mission;
}

function latestRow(root, id) {
  const rows = fs.readFileSync(ledgerPath(root), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.id === id);
  return rows[rows.length - 1];
}

test('pingMission saves the note on the mission and returns it', () => {
  withWorkspace((root) => {
    seedMission(root);
    const saved = pingMission([MISSION_ID, 'check', 'the', 'lint', 'lane', '--from', 'keshav'], { silent: true });

    assert.strictEqual(saved.id, MISSION_ID);
    assert.strictEqual(saved.pings.length, 1);
    const [ping] = saved.pings;
    assert.strictEqual(ping.text, 'check the lint lane');
    assert.strictEqual(ping.from, 'keshav');
    // The clock is not fixed, so only check that the stamp is a real ISO time.
    assert.strictEqual(new Date(ping.at).toISOString(), ping.at);

    assert.deepStrictEqual(latestRow(root, MISSION_ID).pings, saved.pings);
  });
});

test('pingMission prints the unread count and skips pings a tick already consumed', () => {
  withWorkspace((root) => {
    seedMission(root, {
      pings: [{
        at: '2026-10-20T11:00:00.000Z',
        from: 'derrick',
        text: 'old note',
        consumed_at: '2026-10-20T12:00:00.000Z',
      }],
    });
    const out = runCapturing(() => pingMission([MISSION_ID, 'new note', '--from', 'keshav']));

    assert.strictEqual(out.code, null);
    assert.deepStrictEqual(out.logs, [`pinged ${MISSION_ID}, the next tick reads it (1 unread).`]);
  });
});

test('pingMission --json prints one receipt with the pending count and the ping', () => {
  withWorkspace((root) => {
    seedMission(root);
    const out = runCapturing(() => pingMission([MISSION_ID, 'hold the deploy', '--json', '--from', 'keshav']));

    assert.strictEqual(out.logs.length, 1);
    const receipt = JSON.parse(out.logs[0]);
    assert.strictEqual(receipt.ok, true);
    assert.strictEqual(receipt.action, 'mission_ping');
    assert.strictEqual(receipt.mission_id, MISSION_ID);
    assert.strictEqual(receipt.pending_pings, 1);
    assert.strictEqual(receipt.ping.text, 'hold the deploy');
    assert.strictEqual(receipt.ping.from, 'keshav');
  });
});

test('pingMission takes the sender from USER, and falls back to "operator" when USER is unset', () => {
  withWorkspace((root) => {
    seedMission(root);
    const savedUser = process.env.USER;
    try {
      process.env.USER = 'fixture-user';
      const named = pingMission([MISSION_ID, 'first'], { silent: true });
      assert.strictEqual(named.pings[named.pings.length - 1].from, 'fixture-user');

      delete process.env.USER;
      const anonymous = pingMission([MISSION_ID, 'second'], { silent: true });
      assert.strictEqual(anonymous.pings[anonymous.pings.length - 1].from, 'operator');
    } finally {
      if (savedUser === undefined) delete process.env.USER;
      else process.env.USER = savedUser;
    }
  });
});

test('pingMission --help prints usage and exits 0 without writing anything', () => {
  withWorkspace((root) => {
    seedMission(root);
    const file = ledgerPath(root);
    const before = fs.readFileSync(file, 'utf8');
    const out = runCapturing(() => pingMission(['--help']));

    assert.strictEqual(out.code, 0);
    assert.strictEqual(out.logs[0], 'Usage: atris mission ping <id> "<note>" [--from <who>] [--json]');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  });
});

test('pingMission exits 2 with usage when the note is missing or only spaces', () => {
  withWorkspace((root) => {
    seedMission(root);
    const bare = runCapturing(() => pingMission([MISSION_ID]));
    assert.strictEqual(bare.code, 2);
    assert.match(bare.errors[0], /^usage: atris mission ping </);

    const blank = runCapturing(() => pingMission([MISSION_ID, '   ']));
    assert.strictEqual(blank.code, 2);
    assert.match(blank.errors[0], /^usage: atris mission ping </);

    assert.strictEqual(latestRow(root, MISSION_ID).pings.length, 0);
  });
});

test('pingMission exits 1 and names the mission when no mission matches', () => {
  withWorkspace((root) => {
    seedMission(root);
    const out = runCapturing(() => pingMission(['mission-does-not-exist', 'hello']));

    assert.strictEqual(out.code, 1);
    assert.strictEqual(out.errors[0], 'Mission "mission-does-not-exist" not found.');
  });
});

test('pingMission refuses a finished mission and leaves the ledger untouched', () => {
  withWorkspace((root) => {
    seedMission(root, { status: 'complete' });
    const before = fs.readFileSync(ledgerPath(root), 'utf8');
    const out = runCapturing(() => pingMission([MISSION_ID, 'still there?']));

    assert.strictEqual(out.code, 1);
    assert.strictEqual(out.errors[0], `Mission ${MISSION_ID} is complete; pings only reach live missions.`);
    assert.strictEqual(fs.readFileSync(ledgerPath(root), 'utf8'), before);
  });
});
