'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const close = require('../commands/close');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');

test('a loop closed today is listed even when the workspace has no commits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-closed-today-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const now = new Date().toISOString();
  const quiet = console.log;
  console.log = () => {};
  try {
    close.run(['add', 'Approve payroll', '--owner', 'you', '--ttl', '3'], { cwd: root, now });
    close.run(['done', close.closeIdForWhat('Approve payroll')], { cwd: root, now });
  } finally {
    console.log = quiet;
  }
  const html = renderVitalsHtml(root, { now, collectImproveVitals: () => ({}) });
  assert.match(html, /<li class="done"><span class="lane">closed<\/span>Approve payroll<\/li>/);
});
