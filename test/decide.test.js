'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { handleMissionBlocker } = require('../lib/self-drive');
const { buildTickPrompt } = require('../commands/mission');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-decide-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# Atris\n');
  return root;
}

function appendMission(root, mission) {
  fs.appendFileSync(
    path.join(root, '.atris', 'state', 'missions.jsonl'),
    `${JSON.stringify({
      schema: 'atris.mission.v1',
      objective: 'decide test mission',
      status: 'running',
      owner: 'mission-lead',
      created_at: '2026-07-27T08:00:00.000Z',
      updated_at: '2026-07-27T08:00:00.000Z',
      ...mission,
    })}\n`,
  );
}

function latestMission(root, id) {
  return fs.readFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((mission) => mission.id === id)
    .at(-1);
}

function run(root, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_TASKS_DB: path.join(root, '.atris', 'state', 'tasks.db'),
    },
  });
}

test('legacy string asks list and answer through the mission ping path', (t) => {
  const root = makeFixture(t);
  appendMission(root, {
    id: 'mission-legacy01',
    owner: 'researcher',
    human_asks: ['Ship the result?'],
  });

  const listed = run(root, ['decide']);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.match(listed.stdout, /^\[1\] researcher · legacy01 · Ship the result\?$/m);
  assert.match(listed.stdout, /^atris decide <n> y\|n$/m);

  const answered = run(root, ['decide', '1', 'yes', '--note', 'proof is green', '--json']);
  assert.equal(answered.status, 0, answered.stderr || answered.stdout);
  const payload = JSON.parse(answered.stdout);
  assert.equal(payload.action, 'decision_answered');
  assert.equal(payload.decision.answer, 'yes');
  const mission = latestMission(root, 'mission-legacy01');
  assert.equal(mission.human_asks[0].text, 'Ship the result?');
  assert.equal(mission.human_asks[0].answer, 'yes');
  assert.ok(mission.human_asks[0].answered_at);
  assert.equal(mission.human_asks[0].note, 'proof is green');
  assert.equal(mission.pings[0].from, 'decide');
  assert.equal(mission.pings[0].text, 'Decision on "Ship the result?": YES — proof is green');

  const none = run(root, ['decide']);
  assert.equal(none.status, 0, none.stderr || none.stdout);
  assert.equal(none.stdout, 'nothing is waiting for a decision.\n');
});

test('answering one ask leaves its sibling open', (t) => {
  const root = makeFixture(t);
  appendMission(root, {
    id: 'mission-siblings',
    human_asks: ['Choose the title?', 'Publish today?'],
  });

  const answered = run(root, ['decide', '1', 'y']);
  assert.equal(answered.status, 0, answered.stderr || answered.stdout);
  const mission = latestMission(root, 'mission-siblings');
  assert.equal(mission.human_asks[0].answer, 'yes');
  assert.equal(mission.human_asks[1].answered_at, null);

  const listed = run(root, ['decide', '--json']);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const payload = JSON.parse(listed.stdout);
  assert.equal(payload.count, 1);
  assert.equal(payload.decisions[0].text, 'Publish today?');
  assert.equal(payload.decisions[0].ask_index, 1);
});

test('an all-answered mission is not human-blocking for self-drive', () => {
  const mission = {
    id: 'mission-answered',
    status: 'ready',
    human_asks: [{
      text: 'Continue?',
      answered_at: '2026-07-27T09:00:00.000Z',
      answer: 'yes',
      note: '',
    }],
  };
  const result = handleMissionBlocker({
    mission,
    stopReason: 'verifier-failed',
    workspaceRoot: process.cwd(),
  });

  assert.equal(result.reason, 'stop condition met');
  assert.notEqual(result.reason, 'human-blocking');
  assert.doesNotMatch(
    buildTickPrompt(mission, 1, 1, { lane: 'code', verifier: 'true' }),
    /## Human asks/,
  );
});

test('decision numbering stays stable between list and answer calls', (t) => {
  const root = makeFixture(t);
  appendMission(root, {
    id: 'mission-older001',
    updated_at: '2026-07-27T08:00:00.000Z',
    human_asks: ['Older ask'],
  });
  appendMission(root, {
    id: 'mission-newer001',
    updated_at: '2026-07-27T09:00:00.000Z',
    human_asks: ['Newer first', 'Newer second'],
  });

  const listed = run(root, ['decide']);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.match(listed.stdout, /^\[1\].*Newer first$/m);
  assert.match(listed.stdout, /^\[2\].*Newer second$/m);
  assert.match(listed.stdout, /^\[3\].*Older ask$/m);

  const answered = run(root, ['decide', '2', 'y']);
  assert.equal(answered.status, 0, answered.stderr || answered.stdout);
  const newer = latestMission(root, 'mission-newer001');
  assert.equal(newer.human_asks[0].answered_at, null);
  assert.equal(newer.human_asks[1].answer, 'yes');
  assert.equal(latestMission(root, 'mission-older001').human_asks[0], 'Older ask');
});

test('y and n deliver pings with the matching decision text', (t) => {
  const root = makeFixture(t);
  appendMission(root, {
    id: 'mission-bothways',
    human_asks: ['Use option A?', 'Send the draft?'],
  });

  const yes = run(root, ['decide', '1', 'y']);
  assert.equal(yes.status, 0, yes.stderr || yes.stdout);
  const no = run(root, ['decide', '1', 'n']);
  assert.equal(no.status, 0, no.stderr || no.stdout);

  const mission = latestMission(root, 'mission-bothways');
  assert.equal(mission.pings.length, 2);
  assert.equal(mission.pings[0].text, 'Decision on "Use option A?": YES');
  assert.equal(mission.pings[1].text, 'Decision on "Send the draft?": NO');
  assert.deepEqual(mission.human_asks.map((ask) => ask.answer), ['yes', 'no']);
});
