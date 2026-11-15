'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { connectCommand, statusText } = require('../commands/business-connect');

async function run(args, { result, token = 'tok', slug = 'sunset-ink' } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const opened = [];
  const code = await connectCommand(args, {
    log: (line) => out.push(line),
    err: (line) => err.push(line),
    loadCredentials: () => (token ? { token } : null),
    detectBusinessSlug: (explicit) => explicit || slug,
    openBrowser: (url) => { opened.push(url); return true; },
    apiRequestJson: async (path, options) => {
      calls.push({ path, options });
      return result || { ok: true, status: 200, data: {} };
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls, opened };
}

test('status reads as one line per service with the way to connect each', () => {
  const text = statusText('sunset-ink', {
    slack: { connected: true, team_name: 'Sunset Ink HQ' },
    telegram: { connected: false },
    google_drive: { connected: true },
  });
  assert.match(text, /Slack\s+connected, Sunset Ink HQ/);
  assert.match(text, /Telegram\s+not connected\s+atris business connect sunset-ink telegram --token/);
  assert.match(text, /Google Drive\s+connected/);
});

test('no service asks the server what is connected', async () => {
  const { code, calls, out } = await run(['sunset-ink'], { result: { ok: true, status: 200, data: { slack: { connected: true, team_name: 'HQ' } } } });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/business/sunset-ink/integrations');
  assert.match(out, /Slack\s+connected, HQ/);
});

test('telegram posts the bot token and says who the bot is', async () => {
  const { code, calls, out } = await run(['telegram', '--token', '123:abc'], { result: { ok: true, status: 200, data: { connected: true, bot_username: 'sunset_bot' } } });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls[0].path, '/business/sunset-ink/integrations/telegram');
  assert.deepStrictEqual(calls[0].options.body, { bot_token: '123:abc' });
  assert.match(out, /Telegram is connected to sunset-ink as sunset_bot/);
  const missing = await run(['sunset-ink', 'telegram']);
  assert.strictEqual(missing.code, 1);
  assert.strictEqual(missing.calls.length, 0);
  assert.match(missing.err, /--token/);
});

test('slack starts the approval and opens the page, or prints it with --no-open', async () => {
  const start = { ok: true, status: 200, data: { auth_url: 'https://slack.com/oauth?x=1' } };
  const opened = await run(['sunset-ink', 'slack'], { result: start });
  assert.strictEqual(opened.calls[0].path, '/business/sunset-ink/integrations/slack/start');
  assert.strictEqual(opened.calls[0].options.method, 'POST');
  assert.deepStrictEqual(opened.opened, ['https://slack.com/oauth?x=1']);
  assert.match(opened.out, /opening Slack/);
  const printed = await run(['sunset-ink', 'hubspot', '--no-open'], { result: start });
  assert.deepStrictEqual(printed.opened, []);
  assert.match(printed.out, /open this to approve HubSpot/);
});

test('--off disconnects, personal services are redirected, and server errors read as words', async () => {
  const off = await run(['sunset-ink', 'discord', '--off'], { result: { ok: true, status: 200, data: { connected: false } } });
  assert.strictEqual(off.calls[0].options.method, 'DELETE');
  assert.strictEqual(off.calls[0].path, '/business/sunset-ink/integrations/discord');
  assert.match(off.out, /Discord is off/);
  const personal = await run(['sunset-ink', 'linear']);
  assert.strictEqual(personal.code, 1);
  assert.strictEqual(personal.calls.length, 0);
  assert.match(personal.err, /your own account/);
  const denied = await run(['sunset-ink', 'telegram', '--token', 'x'.repeat(12)], { result: { ok: false, status: 403 } });
  assert.match(denied.err, /owner or an admin/);
  const out = await run(['sunset-ink'], { token: null });
  assert.strictEqual(out.code, 1);
});

test('--json prints one object', async () => {
  const { out } = await run(['sunset-ink', '--json'], { result: { ok: true, status: 200, data: { slack: { connected: false } } } });
  const payload = JSON.parse(out);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.business, 'sunset-ink');
});
