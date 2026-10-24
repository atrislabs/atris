const test = require('node:test');
const assert = require('node:assert/strict');
const { safeMarkdownMerge } = require('../commands/business-sync');

test('conflicting insertions before a heading identify the section to review', () => {
  const base = '# Guide\n\n## Sales\n\nOld sales.\n\n## Support\n\nOld support.\n';
  const local = base.replace('## Sales', 'New note.\n## Sales');
  const remote = base.replace('## Sales', 'Cloud note.\n## Sales');

  assert.match(safeMarkdownMerge(base, local, remote).reason, /sales/i);
});
