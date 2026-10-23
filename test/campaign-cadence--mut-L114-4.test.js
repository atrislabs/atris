'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeCadence } = require('../lib/campaign-cadence');
const { createMemoryStore } = require('../lib/campaign-store');

test('zero rounds uses the unlimited default and runs until the loop stops', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cadence-zero-'));
  try {
    const store = createMemoryStore({ origin: 'laptop' });
    store.append({
      campaign_id: 'cmp-zero',
      type: 'campaign_started',
      actor: 'owner',
      data: { title: 'Zero rounds', judge: 'unused', budget: 10, owner: 'owner', seats: ['builder'] },
    });
    const cadence = makeCadence(root, {
      step: async () => ({ stop: true, reason: 'finished fixture work' }),
    }, { rounds: 0, work: '1m', break: '0s' }, {
      store,
      now: () => 0,
      log: () => {},
      sleep: async () => { assert.fail('a stopped loop must not sleep'); },
    });

    const result = await cadence.run('cmp-zero');
    assert.deepEqual({ rounds: result.rounds, reason: result.reason }, {
      rounds: 1,
      reason: 'finished fixture work',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
