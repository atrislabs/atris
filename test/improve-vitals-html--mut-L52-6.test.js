'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');
const close = require('../commands/close');

test('previously closed loops do not appear as shipped today', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-history-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  fs.mkdirSync(path.join(root, 'atris'));
  const what = 'Approve quarterly payroll';
  const log = console.log;
  try {
    console.log = () => {};
    close.run(['add', what, '--owner', 'you', '--ttl', '3'], {
      cwd: root, now: '2026-01-10T12:00:00Z',
    });
    close.run(['done', close.closeIdForWhat(what)], {
      cwd: root, now: '2026-01-10T13:00:00Z',
    });
  } finally {
    console.log = log;
  }
  const html = renderVitalsHtml(root, {
    now: '2026-01-15T12:00:00Z',
    collectImproveVitals: () => ({}),
  });
  assert.equal(html.includes(what), false);
});
