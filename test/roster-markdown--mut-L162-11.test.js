'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replaceJobSection } = require('../lib/roster-markdown');

test('removing the last job with a blank before its worker preserves the preceding pick', () => {
  const result = replaceJobSection([
    '# roster',
    'build: codex',
    '## review',
    '',
    '- haiku',
    '',
  ].join('\n'), { matches: (title) => title === 'review', lines: null });

  assert.equal(result.split(/\r?\n/).includes('build: codex'), true);
});
