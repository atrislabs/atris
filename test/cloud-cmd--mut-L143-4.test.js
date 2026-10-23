'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderCloudCleanSummary } = require('../commands/cloud');

test('cloud clean summary omits a zero deletion count', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cmd-mut-l143-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const summary = renderCloudCleanSummary(['/a.md'], {
    deleted: 0,
    failed: 1,
    localCount: 2,
  });

  assert.equal(
    summary,
    'cloud clean: 1 cloud file not present locally:\n  - a.md\n\n1 failed. local files: 2\n',
  );
});
