'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureCodeBaseline, collectCodeProvenance } = require('../lib/mission-code-provenance');

test('an unavailable captured baseline is rejected before collecting repository evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-baseline-rejection-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const baseline = captureCodeBaseline(root);
    const result = collectCodeProvenance(root, baseline);
    assert.equal(result.reason, 'baseline_unavailable');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
