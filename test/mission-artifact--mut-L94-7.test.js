'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeMissionArtifact } = require('../lib/mission-artifact');

test('a worker receipt supplies the completed timeline summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-objective-'));
  try {
    const written = writeMissionArtifact({
      id: 'release-note',
      objective: 'Publish customer release notes',
      owner: 'sam',
      created_at: '2026-02-01T00:00:00.000Z',
      completed_at: '2026-02-02T00:00:00.000Z',
    }, {
      root,
      proofReceipt: {
        at: '2026-02-01T12:00:00.000Z',
        result: { tick: { atris2: { receipt_text: 'Published customer release notes' } } },
      },
    });
    const blocks = JSON.parse(fs.readFileSync(path.join(root, written.blocks_json), 'utf8'));
    const timeline = blocks.blocks.find(block => block.type === 'timeline');
    assert.ok(timeline.items.some(item => item.body.includes('Published customer release notes')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
