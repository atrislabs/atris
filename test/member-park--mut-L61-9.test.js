'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isMemberParked } = require('../lib/member-park');

test('a missing member name is not treated as parked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'park-missing-name-'));
  try {
    assert.strictEqual(isMemberParked(root, ''), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
