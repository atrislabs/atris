'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeMissionArtifact } = require('../lib/mission-artifact');

test('completed goal includes the saved Claude receipt when no summary was recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-fallback-'));
  try {
    fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({
      at: '2026-01-02T08:00:00.000Z',
      result: {
        tick: {
          claude: { receipt_text: 'Added customer export validation.' },
        },
      },
    }));
    const written = writeMissionArtifact({
      id: 'export-validation',
      objective: 'Validate customer exports',
      owner: 'ada',
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-03T00:00:00.000Z',
    }, { root, proof: 'receipt.json' });
    const blocks = JSON.parse(fs.readFileSync(path.join(root, written.blocks_json), 'utf8'));
    const goal = blocks.blocks.find(block => block.type === 'timeline').items
      .find(item => item.title === 'Goal 1 done');
    assert.match(goal.body, /Added customer export validation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
