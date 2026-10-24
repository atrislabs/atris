const test = require('node:test');
const assert = require('node:assert/strict');
const { memberMarkdown } = require('../lib/member-scaffold');

test('a supplied role becomes the member heading', () => {
  const markdown = memberMarkdown({
    name: 'sage',
    role: 'Researcher',
    description: 'Studies evidence',
  });

  const heading = markdown.match(/\n\n# (.+)\n/);
  assert.strictEqual(heading && heading[1], 'Researcher');
});
