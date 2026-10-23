const test = require('node:test');
const assert = require('node:assert/strict');
const journal = require('../lib/journal');

test('parsing a journal that starts with a section preserves an empty header', () => {
  assert.deepStrictEqual(journal.parseJournalSections('## Notes\nA note\n'), {
    __header__: '',
    Notes: '## Notes\nA note\n',
  });
});
