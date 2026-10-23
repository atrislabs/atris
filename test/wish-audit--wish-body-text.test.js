'use strict';

// wishBodyText is the wish prose with the Check: lines taken out. It is pure:
// no files, no env, no clock, so nothing here needs a temp dir.

const { test } = require('node:test');
const assert = require('node:assert');
const { wishBodyText } = require('../lib/wish-audit');

test('drops every Check: line and keeps the prose in order', () => {
  const text = [
    'Add a retry to the uploader.',
    'Check: npm test -- uploader',
    'It should back off twice before it gives up.',
    '   check: node scripts/upload-smoke.js',
    'Keep the old error message.',
  ].join('\n');

  assert.equal(
    wishBodyText(text),
    'Add a retry to the uploader.\nIt should back off twice before it gives up.\nKeep the old error message.',
  );
});

test('keeps lines that only look like a check, with no colon right after Check', () => {
  const text = [
    'Checkout the release branch: then run it.',
    'Check the logs before you start.',
    'Please Check: this stays because the Check: is not at the start.',
  ].join('\n');

  assert.equal(wishBodyText(text), text);
});

test('handles CRLF line endings and keeps blank lines inside the body', () => {
  const text = '\r\n  Build the export.\r\nCheck: node --test\r\n\r\nWrite the receipt.\r\n';

  assert.equal(wishBodyText(text), 'Build the export.\n\nWrite the receipt.');
});

test('an empty, missing, or check-only wish has no body text', () => {
  assert.equal(wishBodyText(''), '');
  assert.equal(wishBodyText(undefined), '');
  assert.equal(wishBodyText(null), '');
  assert.equal(wishBodyText('Check: npm test\nCHECK: node --version'), '');
});
