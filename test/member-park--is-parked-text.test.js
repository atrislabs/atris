'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isParkedText } = require('../lib/member-park');

function card(lines) {
  return ['---', ...lines, '---', '', '# member', ''].join('\n');
}

test('a card with status parked is parked, and any other status is not', () => {
  assert.strictEqual(isParkedText(card(['name: ada', 'status: parked'])), true);
  assert.strictEqual(isParkedText(card(['name: ada', 'status: active'])), false);
  assert.strictEqual(isParkedText(card(['name: ada', 'role: builder'])), false);
});

test('parked still matches when the status line is quoted, cased, commented, or padded', () => {
  assert.strictEqual(isParkedText(card(['status: "parked"'])), true);
  assert.strictEqual(isParkedText(card(["status: 'PARKED'"])), true);
  assert.strictEqual(isParkedText(card(['status: parked # back later'])), true);
  assert.strictEqual(isParkedText('\uFEFF---\r\nstatus:\t" parked "\r\n---\r\n'), true);
  assert.strictEqual(isParkedText(card(['status: parked-soon'])), false);
  assert.strictEqual(isParkedText(card(['status: not parked'])), false);
});

test('empty or broken text is not parked', () => {
  assert.strictEqual(isParkedText(''), false);
  assert.strictEqual(isParkedText(null), false);
  assert.strictEqual(isParkedText(undefined), false);
  assert.strictEqual(isParkedText('status: parked\n'), false);
  assert.strictEqual(isParkedText('---\nstatus: parked\n'), false);
  assert.strictEqual(isParkedText('---\nname: ada\n---\nstatus: parked\n'), false);
});
