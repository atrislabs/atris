'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectOrbContext } = require('../lib/orb-context');

test('archived conversations are excluded from the thread count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-archived-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const result = await collectOrbContext(root, {
      now: Date.parse('2025-02-12T12:00:00Z'),
      threads: [{
        id: 'archived-conversation',
        title: 'Completed discussion',
        updatedAt: '2025-02-12T10:00:00Z',
        archivedAt: '2025-02-12T11:00:00Z',
      }],
    });
    assert.strictEqual(result.greeting_facts.threadCount, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
