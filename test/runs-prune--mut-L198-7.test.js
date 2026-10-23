'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneRuns } = require('../lib/runs-prune');

test('preview reports the custom run directory relative to the project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-custom-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runsDir = path.join(root, 'saved', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });

  const result = pruneRuns(root, {
    runsDir,
    nowMs: Date.UTC(2026, 9, 23),
  });

  assert.strictEqual(result.runs_dir, 'saved/runs');
});
