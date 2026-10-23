'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate any configuration read while loading the command and its imports.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-render-hires-'));
const savedEnv = {};
for (const key of Object.keys(process.env)) {
  if (key === 'HOME' || key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.HOME = home;
test.after(() => {
  delete process.env.HOME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

const { renderHires } = require('../commands/hire');
const NOW = Date.parse('2026-01-15T12:00:00Z');

test('renders hires in order with spending, relative times, and both scoreboard windows', () => {
  const output = renderHires({ hires: [
    {
      name: 'Maya', status: 'active',
      emails_last_24h: { sent: 8, received: 3 },
      allowance: { monthly_usd: 50, spent_this_month_usd: 1.25 },
      last_run_at: '2026-01-15T10:00:00Z',
      last_result: '  Found\n three leads.  ',
      scoreboard: {
        last_24h: { sent: 8, replies: 1, reply_rate: 0.125, bounces: 0, spend_cents: 125 },
        last_7d: { sent: 20, replies: 4, reply_rate: 0.2, bounces: 2, spend_cents: 300 },
        last_action_at: '2026-01-15T11:30:00Z', capped: true,
      },
    },
    {
      name: 'Ada', emails_last_24h: { sent: 0, received: 0 },
      allowance: { monthly_usd: 10 }, next_run_at: '2026-01-15T15:00:00Z',
    },
  ] }, NOW);

  assert.strictEqual(output, [
    'Maya: sent 8, got 3 emails today · spent $1.25 of $50 · last ran 2 h ago: Found three leads.',
    '  last 24h: sent 8, 1 reply (13%), 0 bounced, spent $1.25 · last 7 days: sent 20, 4 replies (20%), 2 bounced, spent $3 · last action 30 min ago · counts cover only the newest mail',
    'Ada: sent 0, got 0 emails today · $10 a month · first run in 3 h',
  ].join('\n'));
});

test('renders sparse and paused hires without blank scoreboard lines', () => {
  assert.strictEqual(renderHires({ hires: [
    { name: 'Maya', status: 'needs_inbox', schedule: { enabled: false }, scoreboard: {} },
    { name: 'Ada', scoreboard: { last_24h: { sent: 0, reply_rate: '' }, last_7d: {} } },
    { name: 'Sam' },
  ] }, NOW), [
    'Maya: paused, no inbox yet · no inbox · asleep, has not run',
    'Ada: no inbox · has not run yet',
    '  last 24h: sent 0, 0 replies, 0 bounced',
    'Sam: no inbox · has not run yet',
  ].join('\n'));
});

test('returns the getting-started message for missing, empty, or non-array hires', () => {
  const expected = 'No hires yet. Start one: atris hire "Maya" --job "grow the newsletter"';
  for (const data of [undefined, {}, { hires: [] }, { hires: null }, { hires: {} }, { hires: 'Maya' }]) {
    assert.strictEqual(renderHires(data, NOW), expected);
  }
});
