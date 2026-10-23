'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { riskyEdits } = require('../lib/zen-fleet');

test('untracked database names do not expand into other files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-risky-file-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, 'production*.db'), 'database contents');
    fs.writeFileSync(path.join(root, 'production-copy.db'), 'other database');
    assert.equal(riskyEdits(root).filter((file) => file === 'production-copy.db').length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
