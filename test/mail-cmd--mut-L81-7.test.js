'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const { mailCommand } = require('../commands/mail');

test('mail send accepts a trimmed yes from the terminal confirmation', async (t) => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  t.after(() => {
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else delete process.stdin.isTTY;
  });

  const questions = [];
  let closed = false;
  t.mock.method(readline, 'createInterface', (options) => {
    assert.equal(options.input, process.stdin);
    assert.equal(options.output, process.stdout);
    return {
      question(question, answer) {
        questions.push(question);
        answer('  YeS  ');
      },
      close() { closed = true; },
    };
  });

  const output = [];
  const errors = [];
  const requests = [];
  const result = await mailCommand([
    'send', 'maya', '--to', 'pat@example.com', '--subject', 'Hi', '--body', 'Hello Pat',
  ], {
    token: 'test-token',
    findBusiness: () => ({ businessId: 'test-business' }),
    log: (line) => output.push(line),
    err: (line) => errors.push(line),
    apiRequestJson: async (pathname, options) => {
      requests.push({ pathname, options });
      if (pathname === '/business/test-business/mail/inboxes') {
        return { ok: true, data: [{ id: 'inbox-1', email_address: 'maya@example.com' }] };
      }
      assert.equal(pathname, '/business/test-business/mail/inboxes/inbox-1/messages/send');
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.body, { to: 'pat@example.com', subject: 'Hi', text: 'Hello Pat' });
      return { ok: true, data: { id: 'message-1' } };
    },
  });

  assert.deepEqual(output, [
    'From:    maya@example.com\nTo:      pat@example.com\nSubject: Hi\n\nHello Pat\n',
    'Sent from maya@example.com to pat@example.com.',
  ]);
  assert.equal(result, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(questions, ['Send this email? (y/N) ']);
  assert.equal(closed, true);
  assert.equal(requests.length, 2);
});
