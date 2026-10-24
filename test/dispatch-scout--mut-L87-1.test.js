'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { seedScoutContext } = require('../lib/dispatch-scout');

test('content matches supply starting files when names and map give no clues', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-content-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fs.writeFileSync(path.join(root, 'handler.js'), 'function reconcile() { return 1; }\n');
    for (const args of [['init', '-q'], ['add', 'handler.js']]) {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || 'fixture setup failed');
    }
    const seed = seedScoutContext({
      task: { title: 'Repair reconcile behavior' },
      worktreePath: root,
    });
    assert.equal(seed.allowedFiles.includes('handler.js'), true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
