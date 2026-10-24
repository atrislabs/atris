'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');
const close = require('../commands/close');

test('a loop dissolved on a previous day is absent from completed work', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-history-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const originalLog = console.log;
  try {
    console.log = () => {};
    close.run(['add', 'Cancel obsolete supplier review', '--owner', 'you'], {
      cwd: root, now: '2026-01-10T12:00:00.000Z',
    });
    close.run(['dissolve', close.closeIdForWhat('Cancel obsolete supplier review'), '--why', 'Supplier contract ended'], {
      cwd: root, now: '2026-01-11T12:00:00.000Z',
    });
  } finally {
    console.log = originalLog;
  }
  const html = renderVitalsHtml(root, {
    now: '2026-01-15T12:00:00.000Z',
    collectImproveVitals: () => ({}),
  });
  assert.equal(html.includes('Cancel obsolete supplier review'), false);
});
