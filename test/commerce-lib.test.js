'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/commerce.js reaches ~/.atris state through utils/auth. Point HOME at an
// empty temp dir before the module loads so nothing under the real home is read.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-commerce-lib-'));
const realHome = process.env.HOME;
process.env.HOME = sandbox;

const { parseFlags, formatCents, untilText, errorFrom, commerceToken } = require('../lib/commerce');
const { ROLLOUT_MESSAGE } = require('../lib/developer-api');

test.after(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function jwtWithClaims(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('parseFlags turns --flags into snake_case keys and keeps positional words', () => {
  // A bare flag takes the next word as its value, so the flag goes last here.
  const { flags, pos } = parseFlags([
    'buy', 'ticket', '--event-url', 'https://example.test/e/1', '--quantity', '2', '--accept-extras',
  ]);
  assert.deepStrictEqual(flags, {
    event_url: 'https://example.test/e/1',
    quantity: 2,
    accept_extras: true,
  });
  assert.deepStrictEqual(pos, ['buy', 'ticket']);
});

test('parseFlags reads --key=value, parses JSON values, and only numeric keys become numbers', () => {
  const { flags } = parseFlags(['--dollars=25.5', '--name=42', '--intent={"kind":"ticket"}', '--limit', '--x']);
  assert.deepStrictEqual(flags, {
    dollars: 25.5,
    name: '42',
    intent: { kind: 'ticket' },
    limit: true,
    x: true,
  });
});

test('parseFlags treats -h and --help as a help request, and empty argv as nothing', () => {
  assert.deepStrictEqual(parseFlags(['-h']), { flags: { help: true }, pos: [] });
  assert.deepStrictEqual(parseFlags(['--help']), { flags: { help: true }, pos: [] });
  assert.deepStrictEqual(parseFlags(), { flags: {}, pos: [] });
});

test('formatCents prints dollars with two decimals, commas, and a minus for negatives', () => {
  assert.strictEqual(formatCents(0), '$0.00');
  assert.strictEqual(formatCents(1999), '$19.99');
  assert.strictEqual(formatCents(123456789), '$1,234,567.89');
  assert.strictEqual(formatCents(-500), '-$5.00');
});

test('formatCents shows a dash for missing amounts and tags non-USD currencies', () => {
  assert.strictEqual(formatCents(null), '-');
  assert.strictEqual(formatCents(''), '-');
  assert.strictEqual(formatCents('oops'), '-');
  assert.strictEqual(formatCents(500, 'eur'), '$5.00 EUR');
  assert.strictEqual(formatCents(500, 'USD'), '$5.00');
});

test('untilText counts minutes under 90, hours after that, and says expired for past times', () => {
  const now = Date.parse('2026-09-29T18:00:00Z');
  assert.strictEqual(untilText('2026-09-29T18:30:00Z', now), 'in 30 min');
  assert.strictEqual(untilText('2026-09-29T19:29:00Z', now), 'in 89 min');
  assert.strictEqual(untilText('2026-09-29T21:00:00Z', now), 'in 3 h');
  assert.strictEqual(untilText('2026-09-29T17:59:00Z', now), 'expired');
  assert.strictEqual(untilText('2026-09-29T18:00:00Z', now), 'expired');
});

test('untilText returns empty text for a timestamp it cannot read', () => {
  assert.strictEqual(untilText('not a date', Date.now()), '');
  assert.strictEqual(untilText(undefined, Date.now()), '');
});

test('errorFrom returns the backend error message from the envelope, one line', () => {
  const denied = { status: 403, data: { error: { message: 'scope\n  commerce:quote missing', type: 'forbidden' } } };
  assert.strictEqual(errorFrom(denied), 'scope commerce:quote missing');
  const unknown = { status: 404, data: { error: { message: 'no such transaction' } } };
  assert.strictEqual(errorFrom(unknown), 'no such transaction');
});

test('errorFrom says the route is rolling out for a bare 404, and falls back to the raw error', () => {
  assert.strictEqual(errorFrom({ status: 404, data: null }), ROLLOUT_MESSAGE);
  assert.strictEqual(errorFrom({ status: 500, error: 'boom\n  again' }), 'boom again');
  assert.strictEqual(errorFrom({ status: 500 }), 'request failed');
});

test('commerceToken uses the commerce key only with the needed scope and before it expires', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const soon = Math.floor(now / 1000) + 3600;
  const past = Math.floor(now / 1000) - 1;
  const key = jwtWithClaims({ exp: soon, scopes: ['commerce:quote'] });
  const login = '  login-token  ';
  assert.strictEqual(commerceToken({ commerce_agent_token: key, token: login }, 'commerce:quote', now), key);
  assert.strictEqual(commerceToken({ commerce_agent_token: key, token: login }, 'commerce:trade', now), 'login-token');
  const stale = jwtWithClaims({ exp: past, scopes: ['commerce:quote'] });
  assert.strictEqual(commerceToken({ commerce_agent_token: stale, token: login }, 'commerce:quote', now), 'login-token');
  assert.strictEqual(commerceToken({ token: login }, 'commerce:quote', now), 'login-token');
  assert.strictEqual(commerceToken(null, 'commerce:quote', now), '');
});

test('commerceToken reads scopes and expiry from stored creds when the key carries no claims', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const key = jwtWithClaims({});
  const creds = {
    commerce_agent_token: key,
    commerce_agent_token_scopes: ['commerce:quote'],
    commerce_agent_token_expires_at: '2026-10-23T13:00:00Z',
    token: 'login-token',
  };
  assert.strictEqual(commerceToken(creds, 'commerce:quote', now), key);
  assert.strictEqual(commerceToken(creds, 'commerce:trade', now), 'login-token');
  const expired = { ...creds, commerce_agent_token_expires_at: '2026-10-23T11:00:00Z' };
  assert.strictEqual(commerceToken(expired, 'commerce:quote', now), 'login-token');
});
