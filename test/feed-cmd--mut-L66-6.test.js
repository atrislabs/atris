'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorLabel } = require('../commands/feed');

test('a signed-in reader does not become the author of another user’s post', () => {
  const label = authorLabel(
    { author_id: 'other-user-12345' },
    {},
    'signed-in-user',
    'reader@example.com',
  );

  assert.strictEqual(label, 'other-us');
});
