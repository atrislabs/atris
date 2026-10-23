'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempRoots } = require('../lib/task-prune');

test('custom temporary roots put the shorter path before an alphabetically earlier path', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-root-order-')));
  try {
    const longer = path.join(base, 'aaaa-long');
    const shorter = path.join(base, 'z');
    fs.mkdirSync(longer);
    fs.mkdirSync(shorter);
    const roots = tempRoots({ tmpdir: longer, named: [shorter] });
    assert.equal(roots[0], shorter);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
