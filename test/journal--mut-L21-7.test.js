const test = require('node:test');
const assert = require('node:assert');
const journal = require('../lib/journal');

test('isSameTimestamp is false when only one side is missing, even if the other parses as epoch', () => {
  const epoch = '1970-01-01T00:00:00.000Z';
  assert.strictEqual(journal.isSameTimestamp(null, epoch), false);
  assert.strictEqual(journal.isSameTimestamp(epoch, null), false);
});
