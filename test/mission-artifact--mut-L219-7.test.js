'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeMissionArtifact } = require('../lib/mission-artifact');

test('a supplied proof receipt contributes its summary to the timeline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-supplied-receipt-'));
  try {
    const written = writeMissionArtifact({
      id: 'saved-note',
      objective: 'Save the release note',
      owner: 'sam',
      created_at: '2026-02-01T00:00:00.000Z',
      completed_at: '2026-02-02T00:00:00.000Z',
    }, {
      root,
      proofReceipt: {
        at: '2026-02-01T12:00:00.000Z',
        result: { tick: { summary: 'published the release note' } },
      },
    });
    const blocks = JSON.parse(fs.readFileSync(path.join(root, written.blocks_json), 'utf8'));
    const timeline = blocks.blocks.find(block => block.type === 'timeline');
    assert.ok(timeline.items.some(item => item.body.includes('published the release note')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
