'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  payCommand,
  formatCredits,
  cleanTarget,
  targetLabel,
  apiErrorMessage,
} = require('../commands/pay');

const PAY_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

function receipt(overrides = {}) {
  return {
    id: PAY_ID,
    status: 'settled',
    from: 'me-id',
    to: 'nora-id',
    amount_credits: 500,
    memo: '',
    created_at: '2026-10-22T14:03:00Z',
    settled_at: '2026-10-22T14:03:01Z',
    request_id: 'req-1',
    ...overrides,
  };
}

// A fake API helper: replies come off a queue, every call is recorded.
function harness(replies) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls = [];
  const out = [];
  const err = [];
  let n = 0;
  const io = {
    token: 'test-token',
    newId: () => `req-${++n}`,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    request: async (pathname, options) => {
      calls.push({ pathname, options: JSON.parse(JSON.stringify(options || {})) });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next(pathname, options) : next;
    },
  };
  return { io, calls, out, err };
}

function ok(data) {
  return { ok: true, status: 200, data };
}

function apiError(status, code, message) {
  return { ok: false, status, data: { detail: message ? { code, message } : { code } } };
}

test('formatCredits shows credits and dollars', () => {
  assert.equal(formatCredits(500), '500 credits ($5.00)');
  assert.equal(formatCredits(1), '1 credits ($0.01)');
  assert.equal(formatCredits(12345), '12345 credits ($123.45)');
});

test('cleanTarget strips a leading @ and leaves emails and ids alone', () => {
  assert.equal(cleanTarget('@nora'), 'nora');
  assert.equal(cleanTarget('nora'), 'nora');
  assert.equal(cleanTarget('nora@example.com'), 'nora@example.com');
  assert.equal(cleanTarget(PAY_ID), PAY_ID);
  assert.equal(targetLabel('nora'), '@nora');
  assert.equal(targetLabel('@nora'), '@nora');
  assert.equal(targetLabel('nora@example.com'), 'nora@example.com');
});

test('a settled payment prints one line and sends the stripped handle', async () => {
  const h = harness(ok(receipt()));
  const code = await payCommand(['@nora', '500', 'for', 'the', 'logo'], h.io);
  assert.equal(code, 0);
  assert.deepEqual(h.out, ['Paid @nora 500 credits ($5.00). Settled.']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].pathname, '/pay');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.token, 'test-token');
  assert.deepEqual(h.calls[0].options.body, {
    to: 'nora', amount_credits: 500, request_id: 'req-1', memo: 'for the logo',
  });
});

test('a held payment says it is waiting and prints the id', async () => {
  const h = harness(ok(receipt({ status: 'pending', settled_at: null })));
  const code = await payCommand(['nora', '500'], h.io);
  assert.equal(code, 0);
  assert.deepEqual(h.out, [`Sent @nora 500 credits ($5.00). Waiting for them to accept. id ${PAY_ID}`]);
  assert.equal(h.calls[0].options.body.memo, undefined);
});

test('--json prints the raw receipt', async () => {
  const r = receipt({ status: 'pending' });
  const h = harness(ok(r));
  const code = await payCommand(['@nora', '500', '--json'], h.io);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(h.out.join('\n')), r);
});

test('a network error retries once with the same request_id', async () => {
  const h = harness([{ ok: false, status: 0, data: null, error: 'socket hang up' }, ok(receipt())]);
  const code = await payCommand(['@nora', '500'], h.io);
  assert.equal(code, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.body.request_id, 'req-1');
  assert.equal(h.calls[1].options.body.request_id, 'req-1');
  // The helper's own retry is off, so only this one retry happens.
  assert.equal(h.calls[0].options.retries, 0);
  assert.deepEqual(h.out, ['Paid @nora 500 credits ($5.00). Settled.']);
});

test('a second network error stops after one retry', async () => {
  const h = harness({ ok: false, status: 0, data: null, error: 'socket hang up' });
  const code = await payCommand(['@nora', '500'], h.io);
  assert.equal(code, 1);
  assert.equal(h.calls.length, 2);
  assert.match(h.err.join('\n'), /Could not reach Atris/);
});

test('a refused payment is not retried', async () => {
  const h = harness(apiError(402, 'insufficient_credits', 'You have 120 credits; this payment needs 500.'));
  const code = await payCommand(['@nora', '500'], h.io);
  assert.equal(code, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.out.length, 0);
  assert.equal(h.err[0], 'You have 120 credits; this payment needs 500.');
  assert.match(h.err[1], /atris topup/);
});

test('error codes map to plain words when the server sends no message', async () => {
  const cases = [
    [402, 'insufficient_credits', /not have enough credits/],
    [429, 'over_daily_cap', /daily payment limit/],
    [403, 'blocked', /cannot pay this account/],
    [400, 'over_payment_cap', /more than one payment/],
    [503, 'payments_unavailable', /down right now/],
  ];
  for (const [status, code, pattern] of cases) {
    const h = harness(apiError(status, code));
    const exit = await payCommand(['@nora', '500'], h.io);
    assert.equal(exit, 1, code);
    assert.match(h.err[0], pattern, code);
  }
});

test('the server error shape {detail: {error, message}} is read too', () => {
  const res = { ok: false, status: 429, data: { detail: { error: 'over_daily_cap', message: 'Daily limit is 5000 credits.' } } };
  assert.equal(apiErrorMessage(res, 'x'), 'Daily limit is 5000 credits.');
  const bare = { ok: false, status: 403, data: { detail: { error: 'blocked' } } };
  assert.equal(apiErrorMessage(bare, 'x'), 'You cannot pay this account.');
  const plain = { ok: false, status: 404, data: { detail: 'Not found' } };
  assert.equal(apiErrorMessage(plain, 'x'), 'Not found');
});

test('a bad amount never reaches the server', async () => {
  for (const bad of ['five', '0', '-5', '1.5', '$5']) {
    const h = harness(ok(receipt()));
    const code = await payCommand(['@nora', bad], h.io);
    assert.equal(code, 2, bad);
    assert.equal(h.calls.length, 0, bad);
  }
});

test('a missing amount prints usage', async () => {
  const h = harness(ok(receipt()));
  assert.equal(await payCommand(['@nora'], h.io), 2);
  assert.equal(h.calls.length, 0);
  assert.match(h.err[0], /Usage: atris pay/);
});

test('subcommand words never send money', async () => {
  const h = harness(ok(receipt()));
  const code = await payCommand(['accept', '5'], h.io);
  assert.equal(code, 0);
  assert.equal(h.calls[0].pathname, '/pay/5/accept');
});

test('history lists payments newest first in plain lines', async () => {
  const rows = [
    receipt({ status: 'pending', direction: 'out', memo: 'logo' }),
    receipt({ id: 'p2', direction: 'in', from: 'sam-id', amount_credits: 100 }),
  ];
  for (const data of [rows, { payments: rows, count: 2 }]) {
    const h = harness(ok(data));
    const code = await payCommand(['history'], h.io);
    assert.equal(code, 0);
    assert.equal(h.calls[0].pathname, '/pay/history');
    const text = h.out.join('\n');
    assert.match(text, /Payments \(2\)/);
    assert.match(text, /sent 500 credits \(\$5\.00\) to nora-id {2}pending {2}"logo"/);
    assert.match(text, /got 100 credits \(\$1\.00\) from sam-id {2}settled/);
    assert.match(text, new RegExp(`id ${PAY_ID}`));
  }
});

test('history with no payments says so', async () => {
  const h = harness(ok([]));
  assert.equal(await payCommand(['history'], h.io), 0);
  assert.match(h.out[0], /No payments yet/);
});

test('show prints the receipt and --json prints it raw', async () => {
  const r = receipt({ memo: 'logo' });
  let h = harness(ok(r));
  assert.equal(await payCommand(['show', PAY_ID], h.io), 0);
  assert.equal(h.calls[0].pathname, `/pay/${PAY_ID}`);
  assert.match(h.out.join('\n'), /Amount {3}500 credits \(\$5\.00\)/);
  h = harness(ok(r));
  assert.equal(await payCommand(['show', PAY_ID, '--json'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out.join('\n')), r);
});

test('show with an unknown id prints the server message', async () => {
  const h = harness(apiError(404, 'payment_not_found', 'No payment with that id'));
  assert.equal(await payCommand(['show', 'nope'], h.io), 1);
  assert.equal(h.err[0], 'No payment with that id');
});

test('accept and cancel post to the right route', async () => {
  let h = harness(ok(receipt({ status: 'settled' })));
  assert.equal(await payCommand(['accept', PAY_ID], h.io), 0);
  assert.equal(h.calls[0].pathname, `/pay/${PAY_ID}/accept`);
  assert.equal(h.calls[0].options.method, 'POST');
  assert.deepEqual(h.out, ['Accepted. 500 credits ($5.00) are yours.']);

  h = harness(ok(receipt({ status: 'refunded' })));
  assert.equal(await payCommand(['cancel', PAY_ID], h.io), 0);
  assert.equal(h.calls[0].pathname, `/pay/${PAY_ID}/cancel`);
  assert.deepEqual(h.out, ['Canceled. 500 credits ($5.00) went back to the sender.']);

  h = harness(apiError(409, 'not_pending'));
  assert.equal(await payCommand(['cancel', PAY_ID], h.io), 1);
  assert.match(h.err[0], /no longer waiting/);
});

test('accept without an id prints usage', async () => {
  const h = harness(ok(receipt()));
  assert.equal(await payCommand(['accept'], h.io), 2);
  assert.equal(h.calls.length, 0);
});

test('not logged in and expired sessions say how to fix it', async () => {
  let h = harness(ok(receipt()));
  h.io.token = null;
  assert.equal(await payCommand(['@nora', '500'], h.io), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.err[0], /atris login/);

  h = harness({ ok: false, status: 401, data: { detail: 'bad token' } });
  assert.equal(await payCommand(['@nora', '500'], h.io), 1);
  assert.equal(h.err[0], 'Session expired. Run: atris login');
});

test('help prints and exits 0', async () => {
  const h = harness(ok(receipt()));
  assert.equal(await payCommand(['--help'], h.io), 0);
  assert.match(h.out.join('\n'), /atris pay <to> <amount>/);
  assert.equal(h.calls.length, 0);
});
