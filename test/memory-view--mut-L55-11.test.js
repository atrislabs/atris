'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('column text clips to limit with ellipsis', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-clip-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;

  t.after(() => {
    process.env.HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const longText = 'a'.repeat(160);
  fs.writeFileSync(
    path.join(root, 'atris', 'lessons.md'),
    `- **[2026-06-18] sample-entry** \u2014 pass \u2014 ${longText}\n`
  );

  const spec = buildMemorySpec(root);
  const colSlide = spec.slides.find((s) => s.type === 'columns');
  assert.strictEqual(colSlide.columns[0].b, 'a'.repeat(149) + '…');
});
