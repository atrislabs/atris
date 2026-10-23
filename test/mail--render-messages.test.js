'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate any home-based configuration loaded by the command's imports.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mail-render-'));
const savedEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
for (const key of Object.keys(savedEnv)) delete process.env[key];
process.env.HOME = home;
test.after(() => {
  for (const key of Object.keys(process.env)) {
    if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

const { renderMessages } = require('../commands/mail');
const inbox = { email_address: 'agent@example.test' };

test('renders incoming and outgoing messages in supplied order with fixed timestamps', () => {
  assert.strictEqual(renderMessages(inbox, [
    {
      created_at: '2024-03-04T05:06:59Z', direction: 'inbound',
      from_address: 'sender@example.test', subject: '  Hello\n world ',
      body_text: ' First\tline\nsecond line ',
    },
    {
      created_at: '2024-03-03T23:45:00-08:00', direction: 'outbound',
      to_addresses: ['one@example.test', 'two@example.test'],
      subject: 'Reply', body_text: 'Thanks!',
    },
  ]), [
    '2024-03-04 05:06  got   from sender@example.test',
    '  Hello world',
    '  First line second line',
    '2024-03-03 23:45  sent  to one@example.test, two@example.test',
    '  Reply',
    '  Thanks!',
  ].join('\n'));
});

test('uses fallbacks for absent fields and omits blank bodies', () => {
  assert.strictEqual(renderMessages(inbox, [{}, { body_text: ' \n\t ' }]),
    '  got   from ?\n  (no subject)\n  got   from ?\n  (no subject)');
});

test('accepts JSON, plain, malformed JSON, and absent outbound recipients', () => {
  for (const [to_addresses, expected] of [
    ['["one@example.test","two@example.test"]', 'one@example.test, two@example.test'],
    ['one@example.test', 'one@example.test'],
    ['[broken', '[broken'],
    [undefined, ''],
  ]) {
    assert.strictEqual(renderMessages(inbox, [{ direction: 'outbound', to_addresses }]),
      `  sent  to ${expected}\n  (no subject)`);
  }
});

test('clips overlong subjects and bodies but preserves exact-width text', () => {
  for (const extra of [0, 1]) {
    assert.strictEqual(renderMessages(inbox, [{
      subject: 's'.repeat(100 + extra), body_text: 'b'.repeat(160 + extra),
    }]), [
      '  got   from ?',
      `  ${extra ? 's'.repeat(99) + '…' : 's'.repeat(100)}`,
      `  ${extra ? 'b'.repeat(159) + '…' : 'b'.repeat(160)}`,
    ].join('\n'));
  }
});

test('renders an empty inbox with explicit or omitted rows', () => {
  const expected = 'No mail in agent@example.test yet.';
  assert.strictEqual(renderMessages(inbox, []), expected);
  assert.strictEqual(renderMessages(inbox), expected);
});
