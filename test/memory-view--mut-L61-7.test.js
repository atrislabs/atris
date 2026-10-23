'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('a custom workspace brand is preserved in the memory page', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-brand-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const spec = buildMemorySpec(root, { brand: 'Cedar' });
  assert.strictEqual(spec.brand.name, 'Cedar');
});
