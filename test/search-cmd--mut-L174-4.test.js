'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectSearchResults } = require('../commands/search');

test('empty memory layer directory reports exists false', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-layer-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tmpDir, 'atris', 'features'), { recursive: true });

  const results = collectSearchResults(tmpDir, 'alpha');

  assert.strictEqual(results.layers.features.exists, false);
});
