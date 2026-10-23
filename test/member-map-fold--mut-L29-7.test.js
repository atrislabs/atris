'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { foldMapNotesOnMain } = require('../lib/member-map-fold');

test('an unreadable main retains the git diagnostic', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-diagnostic-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const result = foldMapNotesOnMain(root);
  assert.notEqual(result.detail, '');
});
