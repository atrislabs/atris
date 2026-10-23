// renderInboxes is a pure function: it turns rows into text and touches no
// files, env vars, clock, or network. Requiring commands/mail loads the API
// helpers, but they only read env inside functions, so nothing here depends
// on this machine.
const test = require('node:test');
const assert = require('node:assert');
const { renderInboxes } = require('../commands/mail');

const EMPTY_HINT = 'No agent inboxes yet. Hiring an agent makes one: atris hire "<name>" --job "<idea>"';

test('renderInboxes lists each address with its display name in parentheses, one per line', () => {
  const rows = [
    { id: 'ib_1', email_address: 'scout@atrismail.com', display_name: 'Scout' },
    { id: 'ib_2', email_address: 'writer@atrismail.com', display_name: 'Ada Writer' },
  ];
  const out = renderInboxes(rows);
  assert.strictEqual(out, 'scout@atrismail.com  (Scout)\nwriter@atrismail.com  (Ada Writer)');
  assert.ok(!out.includes('ib_1'), 'the inbox id is not shown');
});

test('renderInboxes drops the parentheses when display_name is missing, empty, or null', () => {
  const rows = [
    { id: 'ib_3', email_address: 'bare@atrismail.com' },
    { id: 'ib_4', email_address: 'blank@atrismail.com', display_name: '' },
    { id: 'ib_5', email_address: 'null@atrismail.com', display_name: null },
  ];
  assert.strictEqual(
    renderInboxes(rows),
    'bare@atrismail.com\nblank@atrismail.com\nnull@atrismail.com',
  );
});

test('renderInboxes returns the hire hint for an empty list and for no argument', () => {
  assert.strictEqual(renderInboxes([]), EMPTY_HINT);
  assert.strictEqual(renderInboxes(), EMPTY_HINT);
});
