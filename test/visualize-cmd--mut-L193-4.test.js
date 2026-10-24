'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('workspace context excludes documents with no prompt matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-context-boundary-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = root;
    const { collectWorkspaceContext } = require('../commands/visualize');
    fs.mkdirSync(path.join(root, 'atris', 'context'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'context', 'payroll.md'),
      'Payroll records contain salary details.\n');

    const context = collectWorkspaceContext('draw onboarding workflow', root);
    assert.doesNotMatch(context, /payroll/i);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
