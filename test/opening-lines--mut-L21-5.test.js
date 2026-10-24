const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractOpeningLines } = require('../lib/opening-lines');

test('extracts an opening bullet when the section ends at end of input', () => {
  const bullet = '- **Agency.** Take action.';
  const result = extractOpeningLines(`## operating rules\n\n${bullet}`);
  assert.strictEqual(result, bullet);
});
