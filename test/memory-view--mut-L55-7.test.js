const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMemorySpec } = require('../lib/memory-view');

test('saved field notes retain their insight in the displayed column', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-insight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'));
  const insight = 'Check the saved receipt before repeating a repair.';
  fs.writeFileSync(path.join(root, 'atris', 'learnings.jsonl'), JSON.stringify({
    ts: '2026-06-18T10:00:00.000Z',
    type: 'note',
    key: 'repair-receipt',
    insight,
  }) + '\n');

  const column = buildMemorySpec(root).slides.find((slide) => slide.type === 'columns');
  assert.strictEqual(column.columns[0].b, insight);
});
