'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractHeadings, lastHeadingLevel } = require('../scan');

test('extracts headings from a normal document', () => {
  assert.deepEqual(extractHeadings('# Title\ntext\n## Sub'), ['# Title', '## Sub']);
});

test('reports the last heading level', () => {
  assert.equal(lastHeadingLevel('# Title\ntext\n## Sub'), 2);
});
