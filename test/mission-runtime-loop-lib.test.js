'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  missionRunIntentFromMessage,
  runRuntimeMissionLoop,
  readAtrisGoalState,
} = require('../lib/mission-runtime-loop');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeCli(dir) {
  const cliPath = path.join(dir, 'fake-atris.js');
  fs.writeFileSync(cliPath, `const args = process.argv.slice(2);
if (args.includes('--max-ticks')) {
  process.stdout.write(JSON.stringify({
    ok: true,
    ran_ticks: 1,
    tick_count: 1,
    received: args,
    mission: { id: 'm-1', objective: 'Fix the parser', status: 'complete', runner: 'atris2' },
    ticks: [{ summary: 'patched the parser' }],
  }));
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    received: args,
    mission: { id: 'm-1', objective: 'Fix the parser', status: 'active', runner: 'atris2' },
    atris_goal_state: {
      goal: {
        objective: 'Fix the parser',
        mission_id: 'm-1',
        mission_status: 'active',
        runner: 'atris2',
        next_command: 'atris mission run m-1',
      },
    },
  }));
}
`, 'utf8');
  return cliPath;
}

test('missionRunIntentFromMessage parses a plain run request', () => {
  const saved = process.env.ATRIS_AGENT_ID;
  delete process.env.ATRIS_AGENT_ID;
  try {
    const intent = missionRunIntentFromMessage('atris mission run Fix the parser');
    assert.equal(intent.objective, 'Fix the parser');
    assert.equal(intent.owner, 'mission-lead');
    assert.equal(intent.maxTicks, 1);
    assert.equal(intent.maxWallSeconds, 300);
    assert.equal(intent.cadence, '');
    assert.equal(intent.noRun, false);
    assert.equal(intent.noComplete, false);
    assert.equal(intent.roomPreflight, false);
    assert.equal(intent.noRoomPreflight, true);

    assert.equal(missionRunIntentFromMessage('atris mission status'), null);
    assert.equal(missionRunIntentFromMessage('just chatting'), null);

    process.env.ATRIS_AGENT_ID = 'agent-7';
    assert.equal(missionRunIntentFromMessage('atris mission run hi').owner, 'agent-7');
  } finally {
    if (saved === undefined) delete process.env.ATRIS_AGENT_ID;
    else process.env.ATRIS_AGENT_ID = saved;
  }
});

test('missionRunIntentFromMessage extracts flags and strips quotes', () => {
  const intent = missionRunIntentFromMessage(
    'atris mission run "Fix the parser" --owner kesh --max-ticks 4 --cadence 15m --no-run --no-complete --json'
  );
  assert.equal(intent.objective, 'Fix the parser');
  assert.equal(intent.owner, 'kesh');
  assert.equal(intent.maxTicks, 4);
  assert.equal(intent.cadence, '15m');
  assert.equal(intent.noRun, true);
  assert.equal(intent.noComplete, true);

  const inline = missionRunIntentFromMessage('atris mission run ship it --owner=kesh --max-ticks=3 --max-wall=120');
  assert.equal(inline.owner, 'kesh');
  assert.equal(inline.maxTicks, 3);
  assert.equal(inline.maxWallSeconds, 120);
  assert.equal(inline.objective, 'ship it');

  const preflight = missionRunIntentFromMessage('atris mission run ship it --preflight');
  assert.equal(preflight.roomPreflight, true);
  assert.equal(preflight.noRoomPreflight, false);

  const skipped = missionRunIntentFromMessage('atris mission run ship it --no-preflight');
  assert.equal(skipped.roomPreflight, false);
  assert.equal(skipped.noRoomPreflight, true);
});

test('missionRunIntentFromMessage widens limits for long-run wording', () => {
  const intent = missionRunIntentFromMessage('atris mission run keep improving overnight');
  assert.equal(intent.objective, 'keep improving overnight');
  assert.equal(intent.maxTicks, 96);
  assert.equal(intent.maxWallSeconds, 86400);
  assert.equal(intent.cadence, '15m');
});

test('readAtrisGoalState returns stored goal or null', () => {
  const root = makeTempDir('atris-mrl-goal-');
  try {
    assert.equal(readAtrisGoalState(root), null);

    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const goalFile = path.join(stateDir, 'atris_goal.json');
    fs.writeFileSync(goalFile, JSON.stringify({ goal: { objective: 'ship it', mission_id: 'm-9' } }), 'utf8');
    assert.deepEqual(readAtrisGoalState(root), { objective: 'ship it', mission_id: 'm-9' });

    fs.writeFileSync(goalFile, '{not json', 'utf8');
    assert.equal(readAtrisGoalState(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRuntimeMissionLoop fails fast without cliPath or objective', async () => {
  const noCli = await runRuntimeMissionLoop({ objective: 'Fix the parser' }, {});
  assert.equal(noCli.ok, false);
  assert.equal(noCli.error, 'missing cliPath');
  assert.match(noCli.text, /Blocked: missing cliPath/);

  const noObjective = await runRuntimeMissionLoop({ objective: '' }, { cliPath: '/nonexistent' });
  assert.equal(noObjective.ok, false);
  assert.match(noObjective.text, /Usage: atris mission run/);
});

test('runRuntimeMissionLoop starts a mission and stops after start with noRun', async () => {
  const root = makeTempDir('atris-mrl-norun-');
  try {
    const cliPath = writeFakeCli(root);
    const result = await runRuntimeMissionLoop(
      { objective: 'Fix the parser', owner: 'mission-lead', noRun: true, noRoomPreflight: true },
      { cliPath, cwd: root },
    );
    assert.equal(result.ok, true);
    assert.equal(result.run, undefined);

    const sent = result.start.payload.received;
    assert.deepEqual(sent.slice(0, 3), ['mission', 'run', 'Fix the parser']);
    assert.ok(sent.includes('--runner'));
    assert.ok(sent.includes('atris2'));
    assert.ok(sent.includes('--no-room-preflight'));

    const lines = result.text.split('\n');
    assert.equal(lines[0], 'Atris mission started');
    assert.ok(lines.includes('Goal: Fix the parser'));
    assert.ok(lines.includes('Mission: m-1 - active - atris2'));
    assert.ok(lines.includes('Pursuing: not run (--no-run)'));
    assert.ok(lines.includes('Achieved: no'));
    assert.ok(lines.includes('Next: atris mission run m-1'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRuntimeMissionLoop marks a finished mission achieved', async () => {
  const root = makeTempDir('atris-mrl-run-');
  try {
    const cliPath = writeFakeCli(root);
    const result = await runRuntimeMissionLoop(
      { objective: 'Fix the parser', owner: 'mission-lead', maxTicks: 2, maxWallSeconds: 60 },
      { cliPath, cwd: root },
    );
    assert.equal(result.ok, true);
    assert.equal(result.achieved, true);

    const sent = result.run.payload.received;
    assert.ok(sent.includes('m-1'));
    assert.ok(sent.includes('--max-ticks'));
    assert.ok(sent.includes('2'));
    assert.ok(sent.includes('--complete-on-pass'));

    const lines = result.text.split('\n');
    assert.ok(lines.includes('Atris mission pursued'));
    assert.ok(lines.includes('Ticks: 1/1'));
    assert.ok(lines.includes('Work: patched the parser'));
    assert.ok(lines.includes('Achieved: yes'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
