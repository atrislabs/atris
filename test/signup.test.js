const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHandle, HANDLE_RE, signupCommand } = require('../commands/signup');

test('HANDLE_RE accepts lowercase alnum 3-30', () => {
  assert.ok(HANDLE_RE.test('ada'));
  assert.ok(HANDLE_RE.test('agent007'));
  assert.ok(HANDLE_RE.test('a'.repeat(30)));
});

test('HANDLE_RE rejects too short, too long, symbols, case', () => {
  assert.ok(!HANDLE_RE.test('ab'));
  assert.ok(!HANDLE_RE.test('a'.repeat(31)));
  for (const bad of ['a.b', 'a-b', 'a b', 'Ada', 'a_b', 'a/b']) {
    assert.ok(!HANDLE_RE.test(bad), bad);
  }
});

test('parseHandle picks the first positional, lowercased', () => {
  assert.equal(parseHandle(['NewBie']), 'newbie');
  assert.equal(parseHandle(['--json', 'ghost']), 'ghost');
  assert.equal(parseHandle(['  Spaced  ']), 'spaced');
  assert.equal(parseHandle([]), '');
  assert.equal(parseHandle(['help']), '');
  assert.equal(parseHandle(['--help', 'ghost']), 'ghost');
});

test('signupCommand returns 1 on missing handle without a network call', async () => {
  const code = await signupCommand([]);
  assert.equal(code, 1);
});

test('signupCommand treats help as usage without POW or network', async () => {
  assert.equal(await signupCommand(['help']), 2);
  assert.equal(await signupCommand(['--help']), 2);
  assert.equal(await signupCommand(['-h']), 2);
});

test('signupCommand returns 1 on invalid handle without a network call', async () => {
  // Symbols / wrong length fail the client-side guard before any request.
  assert.equal(await signupCommand(['a.b!']), 1);
  assert.equal(await signupCommand(['ab']), 1);
});
