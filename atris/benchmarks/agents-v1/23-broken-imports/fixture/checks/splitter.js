'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { splitFile } = require('../lib/splitter');

test('splits csv rows into chunks of two', () => {
  const tmp = path.join(os.tmpdir(), `bench-csv-${Date.now()}-${Math.random().toString(16).slice(2)}.csv`);
  fs.writeFileSync(tmp, 'A1,3\nB2,1\nC3,5\nD4,2\n');
  try {
    const chunks = splitFile(tmp);
    assert.deepEqual(chunks, ['A1,3\nB2,1', 'C3,5\nD4,2']);
  } finally {
    fs.rmSync(tmp);
  }
});
