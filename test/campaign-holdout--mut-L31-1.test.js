'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { moveHoldoutIn } = require('../lib/campaign-holdout');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atris-holdout-'));

test('moveHoldoutIn falls back to copy and unlink on EXDEV cross-device link error', () => {
  const home = tmp();
  const repo = tmp();
  const source = path.join(repo, 'holdout.jsonl');
  fs.writeFileSync(source, 'data\n');

  const realLink = fs.linkSync;
  fs.linkSync = (from, to) => {
    if (from !== source) return realLink(from, to);
    const err = new Error('cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  };

  try {
    const moved = moveHoldoutIn(home, 'c1', source);
    assert.equal(moved.path, path.join(home, 'campaigns', 'c1', 'holdout', 'holdout.jsonl'));
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(moved.path, 'utf8'), 'data\n');
  } finally {
    fs.linkSync = realLink;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
});
