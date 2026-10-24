'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prune = require('../lib/task-prune');

test('a temporary root retargeted to another directory does not classify its missing projects as junk', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-retarget-'));
  try {
    const root = fs.realpathSync(base);
    const original = path.join(root, 'original');
    const replacement = path.join(root, 'replacement');
    const link = path.join(root, 'temporary');
    fs.mkdirSync(original);
    fs.mkdirSync(replacement);
    fs.symlinkSync(original, link);
    const roots = prune.tempRoots({ tmpdir: link, named: [] });

    fs.unlinkSync(link);
    fs.symlinkSync(replacement, link);
    assert.equal(prune.tempPrefixFor(path.join(link, 'project-A1b2C3'), roots), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
