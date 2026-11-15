'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { growthCommand, growthText } = require('../commands/growth');

const overview = {
  totals: { people: 653, signups_today: 2, signups_7d: 15, signups_prev_7d: 10, signups_30d: 56, paying: 7, mrr_usd: 320 },
  cli_installs: { last_7d: 1847, prev_7d: 5393 },
  countries: [{ country: 'US', people: 40 }, { country: 'IN', people: 12 }],
  marks: [{ label: 'Lagos', people: 3 }, { label: 'Austin' }],
  notes: [{ id: 'n1', day: '2026-11-04', text: 'Sent 4 warm notes' }],
};

async function run(args, { result, token = 'tok' } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const opened = [];
  const code = await growthCommand(args, {
    log: (line) => out.push(line),
    err: (line) => err.push(line),
    loadCredentials: () => (token ? { token } : null),
    apiRequestJson: async (path, options) => {
      calls.push({ path, options });
      return result || { ok: true, status: 200, data: overview };
    },
    openPage: (url) => opened.push(url),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls, opened };
}

test('prints the growth numbers in a few short lines', () => {
  const text = growthText(overview);
  assert.match(text, /signups {3}2 today, 15 last 7 days, up 50%, 56 last 30/);
  assert.match(text, /people {4}653 total, 7 paying/);
  assert.match(text, /revenue {3}\$320 a month/);
  assert.match(text, /installs {2}1,847 last 7 days, down 66%/);
  assert.match(text, /places {4}US 40, IN 12/);
  assert.match(text, /marked {4}Lagos 3, Austin/);
  assert.match(text, /Nov 4 {2}Sent 4 warm notes/);
  assert.match(text, /atris\.ai\/dashboard\/growth/);
});

test('says so when nothing is recorded, and skips what is missing', () => {
  const text = growthText({ totals: { signups_7d: 3, signups_prev_7d: 0 } });
  assert.match(text, /3 last 7 days, 0 last 30/);
  assert.match(text, /places {4}none recorded yet/);
  assert.doesNotMatch(text, /installs|marked|notes/);
});

test('reads the same numbers the page reads', async () => {
  const { code, out, calls } = await run([]);
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/admin/growth/overview?days=28');
  assert.strictEqual(calls[0].options.token, 'tok');
  assert.match(out, /653 total/);
});

test('--json prints one object', async () => {
  const { out } = await run(['--json']);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.totals.paying, 7);
});

test('signed out asks for a login and calls nothing', async () => {
  const { code, err, calls } = await run([], { token: '' });
  assert.strictEqual(code, 1);
  assert.match(err, /atris login/);
  assert.strictEqual(calls.length, 0);
});

test('a non-team account gets a plain refusal', async () => {
  const { code, err } = await run([], { result: { ok: false, status: 403, error: 'Forbidden' } });
  assert.strictEqual(code, 1);
  assert.match(err, /only for the Atris team/);
});

test('--open opens the page without needing a login', async () => {
  const { code, out, opened, calls } = await run(['--open'], { token: '' });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(opened, ['https://atris.ai/dashboard/growth']);
  assert.match(out, /dashboard\/growth/);
  assert.strictEqual(calls.length, 0);
});

test('note saves the words and the day, once', async () => {
  const result = { ok: true, status: 200, data: { id: 'n9', day: '2026-11-08', text: 'posted the video' } };
  const { code, out, calls } = await run(['note', 'posted', 'the', 'video', '--day', '2026-11-08'], { result });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/admin/growth/notes');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.retries, 0);
  assert.deepStrictEqual(calls[0].options.body, { text: 'posted the video', day: '2026-11-08' });
  assert.match(out, /noted for Nov 8: posted the video/);
});

test('note refuses empty words, long words and a bad day before calling', async () => {
  for (const args of [['note'], ['note', 'x'.repeat(281)], ['note', 'hi', '--day', 'tuesday']]) {
    const { code, calls } = await run(args);
    assert.strictEqual(code, 1);
    assert.strictEqual(calls.length, 0);
  }
});
