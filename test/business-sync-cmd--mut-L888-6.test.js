const test = require('node:test');
const assert = require('node:assert/strict');
const { describeWatchFailure } = require('../commands/business-sync');

test('ordinary sync failures keep the watcher retrying instead of pausing for review', () => {
  const error = new Error('connection reset by peer');
  error.code = 'ECONNRESET';

  assert.equal(describeWatchFailure(error).state, 'retrying');
});
