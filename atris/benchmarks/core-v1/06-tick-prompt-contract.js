'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'tick-prompt-contract',
  title: 'Mission tick prompt keeps frozen verifier, pings, and layer receipt contract',
  timeoutMs: 10000,
  async run(ctx) {
    const {
      buildTickPrompt,
      extractLayerFromReceiptText,
    } = require(path.join(ctx.repoRoot, 'commands', 'mission.js'));
    assert.equal(typeof buildTickPrompt, 'function');

    const prompt = buildTickPrompt(
      {
        id: 'mission-bench',
        objective: 'Keep the bench prompt contract stable',
        owner: 'mission-lead',
        cadence: 'manual',
        status: 'running',
        last_tick_at: null,
      },
      2,
      4,
      {
        lane: 'code',
        verifier: 'node --test test/mission-tick-prompt.test.js',
      },
      [
        { at: '2026-07-05T18:00:00.000Z', from: 'operator', text: 'ship a smaller slice' },
        { at: '2026-07-05T18:01:00.000Z', from: 'operator', text: 'keep the verifier frozen' },
      ],
    );

    assert.ok(prompt.includes('**Verifier (frozen):** node --test test/mission-tick-prompt.test.js'));
    assert.ok(prompt.includes('## Operator pings (read these first)'));
    assert.ok(prompt.includes('- [2026-07-05T18:00:00.000Z] operator: ship a smaller slice'));
    assert.ok(prompt.includes('layer: identity|beliefs|capabilities|behaviors|environment'));

    const explicit = extractLayerFromReceiptText('changed the prompt contract\nlayer: environment');
    assert.deepEqual(explicit, { layer: 'environment', source: 'explicit' });
    const docsOnly = extractLayerFromReceiptText('the contract says: layer: identity|beliefs|capabilities|behaviors|environment');
    assert.deepEqual(docsOnly, { layer: null, source: 'unknown' });
  },
};
