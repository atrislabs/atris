'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectWorkspaceState } = require('../lib/state-detection');

test('an in-progress feature marks the workspace as active', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-active-feature-'));
  const previousHome = process.env.HOME;
  const previousDb = process.env.ATRIS_TASKS_DB;
  process.env.HOME = root;
  process.env.ATRIS_TASKS_DB = path.join(root, 'missing.db');
  try {
    const feature = path.join(root, 'atris', 'features', 'invoice-export');
    fs.mkdirSync(feature, { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# Workspace\n');
    fs.writeFileSync(path.join(feature, 'idea.md'), '# Invoice export\n\n**Status:** in-progress\n');
    assert.equal(detectWorkspaceState(root).state, 'in-progress');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
  }
});
