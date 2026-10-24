'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPullConflictReviewPacket } = require('../commands/pull');

test('a conflict without a saved baseline does not offer a fabricated base copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pull-baseline-'));
  try {
    fs.writeFileSync(path.join(root, 'notes.md'), 'local notes\n');
    const packet = buildPullConflictReviewPacket(
      root,
      [{ path: '/notes.md', status: 'conflict_updated', action: 'review' }],
      { '/notes.md': 'cloud notes\n' },
      '2025-01-01T12-00-00Z'
    );
    assert.equal(Object.keys(packet.files).some(name => name.endsWith('notes.md.base')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
