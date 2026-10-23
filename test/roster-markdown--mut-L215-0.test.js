'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replaceTeamLine } = require('../lib/roster-markdown');

test('updating a team member replaces their existing engine', () => {
  const result = replaceTeamLine([
    '# roster',
    'build: codex',
    '',
    '## team',
    'researcher: haiku',
    '',
  ].join('\n'), 'researcher', 'codex');

  const memberLines = result.split(/\r?\n/).filter((line) => /^\s*-?\s*researcher:/.test(line));
  assert.equal(memberLines.length, 1);
  assert.match(memberLines[0], /researcher:\s*codex\b/);
});
