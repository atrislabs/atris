'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml, writeVitalsHtml, vitalsHtmlPath } = require('../lib/improve-vitals-html');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-vitals-html-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('renders collected sentences in order, escapes HTML, and shows empty states', (t) => {
  const root = workspace(t);
  const now = '2026-01-15T12:00:00.000Z';
  let calls = 0;
  const html = renderVitalsHtml(root, {
    now,
    collectImproveVitals(options) {
      calls += 1;
      assert.deepStrictEqual(options, { workspace: root, now });
      return {
        usage: { sentence: 'usage last' },
        heartbeat: { sentence: '<script> & heartbeat' },
        exploit: { sentence: 'exploit next' },
        explore: { sentence: '' },
        excrete: null,
        unrelated: { sentence: 'must not appear' },
      };
    },
  });
  assert.strictEqual(calls, 1);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.deepStrictEqual(html.match(/<p class="vital">.*?<\/p>/g), [
    '<p class="vital">&lt;script&gt; &amp; heartbeat</p>',
    '<p class="vital">exploit next</p>',
    '<p class="vital">usage last</p>',
  ]);
  assert.ok(!html.includes('must not appear'));
  assert.ok(html.includes('nothing needs you right now.'));
  assert.ok(html.includes('no open loops on the system side.'));
  assert.ok(html.includes('nothing yet today.'));
  assert.ok(html.includes('<meta http-equiv="refresh" content="60">'));
});

test('writes the rendered page into nested state directories and replaces existing content', (t) => {
  const root = workspace(t);
  const expectedPath = path.join(root, '.atris', 'state', 'improve-vitals.html');
  const deps = {
    now: '2026-01-15T12:00:00.000Z',
    collectImproveVitals: () => ({ heartbeat: { sentence: 'fresh heartbeat' } }),
  };
  assert.strictEqual(vitalsHtmlPath(root), expectedPath);
  assert.strictEqual(fs.existsSync(path.dirname(expectedPath)), false);
  assert.strictEqual(writeVitalsHtml(root, deps), expectedPath);
  assert.strictEqual(fs.readFileSync(expectedPath, 'utf8'), renderVitalsHtml(root, deps));
  fs.writeFileSync(expectedPath, 'stale page');
  assert.strictEqual(writeVitalsHtml(root, deps), expectedPath);
  const written = fs.readFileSync(expectedPath, 'utf8');
  assert.ok(written.includes('<p class="vital">fresh heartbeat</p>'));
  assert.ok(!written.includes('stale page'));
});
