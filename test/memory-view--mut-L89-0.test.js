'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('only the newest lesson is active in recent updates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-active-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), [
      '- **[2026-06-18] small-changes** - pass - Keep changes small.',
      '- **[2026-06-19] check-output** - pass - Check the output.',
      '',
    ].join('\n'));
    const spec = buildMemorySpec(root);
    const rows = spec.slides.find((slide) => slide.type === 'panel').panel.rows;
    assert.strictEqual(rows[0].active, true);
    assert.strictEqual(rows[1].active, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
