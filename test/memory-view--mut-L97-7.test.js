const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('field note headings prefer the learning key over its type', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-heading-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'learnings.jsonl'), JSON.stringify({
    key: 'verify-before-shipping',
    type: 'pitfall',
    insight: 'Run the check before shipping.',
  }) + '\n');

  const spec = buildMemorySpec(root);
  const notes = spec.slides.find((slide) => slide.heading === 'Notes from the field');
  assert.deepEqual(notes, {
    type: 'columns',
    heading: 'Notes from the field',
    columns: [{ h: 'verify before shipping', b: 'Run the check before shipping.' }],
  });
});
