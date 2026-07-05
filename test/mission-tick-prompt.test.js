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
