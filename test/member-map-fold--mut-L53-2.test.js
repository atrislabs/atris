'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { foldNotesText } = require('../lib/member-map-fold');

test('new notes join a heading at the start without duplicating it', () => {
  const { text } = foldNotesText(
    '## Alpha\nexisting route\n\n## Beta\nother route\n',
    [{ text: '## Alpha\nnew route\n' }],
  );

  assert.equal(text.split('\n').filter((line) => line === '## Alpha').length, 1);
  assert.ok(text.indexOf('new route') < text.indexOf('## Beta'));
});
