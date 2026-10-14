'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTickPrompt, extractLayerFromReceiptText } = require('../commands/mission');

test('buildTickPrompt keeps frozen verifier line', () => {
  const prompt = buildTickPrompt(
    {
      id: 'mission-prompt',
      objective: 'Keep mission ticks auditable',
      owner: 'mission-lead',
      cadence: 'manual',
      status: 'running',
      last_tick_at: null,
    },
    1,
    3,
    { lane: 'code', verifier: 'node --test test/mission-tick-prompt.test.js' },
  );
  assert.ok(prompt.includes('**Verifier (frozen):** node --test test/mission-tick-prompt.test.js'));
});

test('buildTickPrompt includes operator ping lines before task body', () => {
  const prompt = buildTickPrompt(
    {
      id: 'mission-prompt',
      objective: 'Keep mission ticks auditable',
      owner: 'mission-lead',
      cadence: 'manual',
      status: 'running',
    },
    2,
    4,
    { lane: 'code', verifier: 'true' },
    [
      { at: '2026-07-05T18:00:00.000Z', from: 'operator', text: 'ship less' },
      { at: '2026-07-05T18:01:00.000Z', from: 'operator', text: 'keep the verifier fixed' },
    ],
  );
  const pingIndex = prompt.indexOf('## Operator pings (read these first)');
  const taskIndex = prompt.indexOf('## Your task');
  assert.ok(pingIndex > 0);
  assert.ok(taskIndex > pingIndex);
  assert.ok(prompt.includes('- [2026-07-05T18:00:00.000Z] operator: ship less'));
  assert.ok(prompt.includes('- [2026-07-05T18:01:00.000Z] operator: keep the verifier fixed'));
});

test('buildTickPrompt includes layer receipt instruction', () => {
  const prompt = buildTickPrompt(
    {
      id: 'mission-prompt',
      objective: 'Keep mission ticks auditable',
      owner: 'mission-lead',
      cadence: 'manual',
      status: 'running',
    },
    1,
    1,
    { lane: 'workspace', verifier: '' },
  );
  assert.ok(prompt.includes('layer: identity|beliefs|capabilities|behaviors|environment'));
  assert.ok(prompt.includes('final line'));
  assert.ok(prompt.includes('The tick is not done until the verify step passes'));
  assert.ok(prompt.includes('finish by actually running the surface you changed on this computer'));
  assert.ok(prompt.includes('After that one verify step, STOP'));
  assert.ok(prompt.includes('Never start a second slice in one tick'));
});

test('layer parser round-trips explicit receipt layer and ignores enum docs', () => {
  assert.deepEqual(
    extractLayerFromReceiptText('changed the mission prompt\nlayer: capabilities'),
    { layer: 'capabilities', source: 'explicit' },
  );
  assert.deepEqual(
    extractLayerFromReceiptText('the prompt says: layer: identity|beliefs|capabilities|behaviors|environment'),
    { layer: null, source: 'unknown' },
  );
});

test('buildTickPrompt preloads member identity, soul, standing mission, and bound task context', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tick-preload-'));
  try {
    const memberDir = path.join(root, 'atris', 'team', 'navigator');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Navigator\nRole: Strategic Planner\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'SOUL.md'), '# Soul\nThink from first principles.\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\nKeep the fleet aligned.\n', 'utf8');

    const prompt = buildTickPrompt(
      {
        id: 'mission-preload',
        objective: 'Map the fleet HUD contract',
        owner: 'navigator',
        cadence: 'manual',
        status: 'running',
        xp_task: { ref: 'TSK-42', title: 'Expose fleet HUD JSON', status: 'claimed' },
      },
      1,
      2,
      { lane: 'code', verifier: 'true' },
      [],
      root,
    );

    assert.ok(prompt.includes('## Preloaded Member & Task Context'));
    assert.ok(prompt.includes('### Member Identity (atris/team/navigator/MEMBER.md)'));
    assert.ok(prompt.includes('Role: Strategic Planner'));
    assert.ok(prompt.includes('### Member Soul (atris/team/navigator/SOUL.md)'));
    assert.ok(prompt.includes('Think from first principles.'));
    assert.ok(prompt.includes('### Member Standing Mission (atris/team/navigator/MISSION.md)'));
    assert.ok(prompt.includes('Keep the fleet aligned.'));
    assert.ok(prompt.includes('### Bound Task Context'));
    assert.ok(prompt.includes('TSK-42: Expose fleet HUD JSON (claimed)'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
