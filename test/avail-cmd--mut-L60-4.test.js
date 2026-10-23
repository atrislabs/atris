'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('noon is a valid twelve-hour time', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-noon-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { parseTimeToDecimal } = require('../commands/avail');
    assert.strictEqual(parseTimeToDecimal('12pm'), 12);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
