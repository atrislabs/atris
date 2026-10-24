'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeMissionArtifact } = require('../lib/mission-artifact');

test('the timeline page shows the raw proof artifact path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-proof-link-'));
  try {
    const written = writeMissionArtifact({
      id: 'saved-note',
      objective: 'Save the note',
      owner: 'sam',
      created_at: '2026-02-01T00:00:00.000Z',
      completed_at: '2026-02-02T00:00:00.000Z',
      completion_gate: { source: 'no_verifier' },
    }, { root });
    const html = fs.readFileSync(path.join(root, written.index_html), 'utf8');
    assert.ok(html.includes(written.raw_json));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
