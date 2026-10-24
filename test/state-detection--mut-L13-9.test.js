'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectWorkspaceState } = require('../lib/state-detection');

test('an empty idea draft does not mark a feature as active', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-idea-'));
  const previousHome = process.env.HOME;
  const previousDb = process.env.ATRIS_TASKS_DB;
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'missing.db');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
  });
  const feature = path.join(root, 'atris', 'features', 'invoice-export');
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(feature, 'idea.md'), '');

  assert.strictEqual(detectWorkspaceState(root).state, 'ready');
});
