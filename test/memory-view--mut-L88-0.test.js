require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('an unresolved failed lesson has urgent severity in recent updates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-severity-'));
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'),
    '- **[2026-04-01] parser-failure** - fail - Validate input before parsing.\n');

  const spec = buildMemorySpec(root);
  const updates = spec.slides.find((slide) => slide.type === 'panel');
  assert.strictEqual(updates.panel.rows[0].sev, 0);
});
