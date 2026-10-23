const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let tmpHome;
let reportError;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pay-report-error-'));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tmpHome;
  ({ reportError } = require('../commands/pay'));
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeIo() {
  const errors = [];
  return { io: { error: (line) => errors.push(line) }, errors };
}

test('reportError says to log in when the result is flagged notLoggedIn', () => {
  const { io, errors } = makeIo();
  const code = reportError(io, { ok: false, status: 401, data: null, notLoggedIn: true }, 'fallback');
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, ['Not logged in. Run: atris login']);
});

test('reportError says the session expired on a plain 401', () => {
  const { io, errors } = makeIo();
  const code = reportError(io, { ok: false, status: 401, data: { detail: 'nope' } }, 'fallback');
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, ['Session expired. Run: atris login']);
});

test('reportError prints a string detail from the server as is', () => {
  const { io, errors } = makeIo();
  const code = reportError(io, { ok: false, status: 400, data: { detail: 'Amount too large' } }, 'fallback');
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, ['Amount too large']);
});

test('reportError falls back to data.error when there is no detail', () => {
  const { io, errors } = makeIo();
  reportError(io, { ok: false, status: 500, data: { error: 'boom' } }, 'fallback');
  assert.deepStrictEqual(errors, ['boom']);
});

test('reportError prefers the server message inside a detail object', () => {
  const { io, errors } = makeIo();
  const res = { ok: false, status: 400, data: { detail: { code: 'blocked', message: 'Custom block text' } } };
  const code = reportError(io, res, 'fallback');
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, ['Custom block text']);
});

test('reportError reads a nested detail.error.message', () => {
  const { io, errors } = makeIo();
  const res = { ok: false, status: 400, data: { detail: { error: { message: 'Nested words' } } } };
  reportError(io, res, 'fallback');
  assert.deepStrictEqual(errors, ['Nested words']);
});

test('reportError uses plain words for a known code with no message', () => {
  const { io, errors } = makeIo();
  const res = { ok: false, status: 400, data: { detail: { code: 'self_payment' } } };
  reportError(io, res, 'fallback');
  assert.deepStrictEqual(errors, ['You cannot pay yourself.']);
});

test('reportError prints the plain words and then the hint for insufficient_credits', () => {
  const { io, errors } = makeIo();
  const res = { ok: false, status: 402, data: { detail: { code: 'insufficient_credits' } } };
  const code = reportError(io, res, 'fallback');
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, [
    'You do not have enough credits for this payment.',
    'Check your credits: atris balance · Buy more: atris topup',
  ]);
});

test('reportError still prints the hint when the server sent its own message', () => {
  const { io, errors } = makeIo();
  const res = { ok: false, status: 402, data: { detail: { error: 'insufficient_credits', message: 'Short by 50' } } };
  reportError(io, res, 'fallback');
  assert.deepStrictEqual(errors, [
    'Short by 50',
    'Check your credits: atris balance · Buy more: atris topup',
  ]);
});

test('reportError says Atris is unreachable on status 0', () => {
  const { io, errors } = makeIo();
  const code = reportError(io, { ok: false, status: 0, data: null }, 'fallback');
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, ['Could not reach Atris. Check your connection and try again.']);
});

test('reportError uses the fallback for an unknown code', () => {
  const { io, errors } = makeIo();
  const res = { ok: false, status: 418, data: { detail: { code: 'made_up_code' } } };
  reportError(io, res, 'Payment failed (418)');
  assert.deepStrictEqual(errors, ['Payment failed (418)']);
});

test('reportError uses the fallback when the result is empty', () => {
  for (const res of [null, undefined, {}, { data: null }, { data: {} }]) {
    const { io, errors } = makeIo();
    const code = reportError(io, res, 'Could not load payments (500)');
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(errors, ['Could not load payments (500)']);
  }
});
