'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reconcileCampaign } = require('../lib/campaign-missions');
const { createMemoryStore } = require('../lib/campaign-store');

test('reconciling a campaign that does not exist returns no ended missions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMemoryStore({ origin: 'test' });

  assert.deepEqual(
    reconcileCampaign(root, 'cmp-missing', new Set(['complete', 'stopped']), { store }),
    [],
  );
});
