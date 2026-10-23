'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replaceJobSection } = require('../lib/roster-markdown');

test('adding a job before an initial team section leaves no leading blank line', () => {
  const result = replaceJobSection('## team\n- researcher: search\n', {
    matches: (title) => title === 'build',
    heading: '## build',
    lines: ['- codex'],
  });

  assert.equal(result.startsWith('\n'), false);
});
