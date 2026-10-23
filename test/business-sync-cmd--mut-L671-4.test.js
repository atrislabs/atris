const test = require('node:test');
const assert = require('node:assert/strict');
const { safeLineMerge } = require('../commands/business-sync');

test('merging a new checklist item preserves removal of a duplicate item', () => {
  const duplicate = '- review invoices';
  const base = `${duplicate}\n${duplicate}\n- send report\n`;
  const local = `- check receipts\n${base}`;
  const cloud = `${duplicate}\n- send report\n`;

  const merged = safeLineMerge(base, local, cloud);

  assert.equal(merged.ok, true);
  assert.equal(
    merged.content.split('\n').filter((line) => line === duplicate).length,
    1,
    'the duplicate removed in the cloud must stay removed'
  );
  assert.ok(merged.content.split('\n').includes('- check receipts'));
});
