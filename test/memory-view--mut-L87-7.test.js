'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('recent updates preserve the verdict of an unresolved failed lesson', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-verdict-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'),
    '- **[2026-04-02] parser-check** - fail - Check the parser.\n');

  const spec = buildMemorySpec(root);
  const updates = spec.slides.find((slide) => slide.type === 'panel');
  assert.strictEqual(updates.panel.rows[0].value, 'fail');
});
