'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const work = { account_id: 'work', email: 'work@example.test', products: { gmail: { connected: true }, calendar: { connected: true }, drive: { connected: false } } };
const roster = { accounts: [work], defaults: { gmail: 'work', calendar: 'work', drive: null }, resolved: { gmail: 'work', calendar: 'work', drive: null }, business: { business_id: 'shop', account_id: 'work' } };
const oldMail = [{ account_id: 'work', email_address: 'work@example.test' }];

async function fixture(handler, run, { business = false, sticky } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-http-test-'));
  fs.mkdirSync(path.join(root, 'atris')); fs.mkdirSync(path.join(root, '.atris')); fs.mkdirSync(path.join(root, 'bin'));
  if (business) fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ business_id: 'shop' }));
  if (sticky) fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: sticky }));
  for (const command of ['open', 'xdg-open']) { const file = path.join(root, 'bin', command); fs.writeFileSync(file, '#!/bin/sh\nexit 1\n'); fs.chmodSync(file, 0o755); }
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url, 'http://localhost');
    const call = { method: req.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : null, business: req.headers['x-business-id'] || null };
    calls.push(call);
    const reply = await handler(call) || [404, { detail: 'not found' }];
    res.writeHead(reply[0], { 'content-type': 'application/json' }); res.end(JSON.stringify(reply[1]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const part = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token = `${part({ alg: 'none' })}.${part({ type: 'agent_access', sub: 'test-person', exp: 4102444800 })}.test`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ATRIS_')));
  Object.assign(env, { HOME: root, USERPROFILE: root, PATH: `${path.join(root, 'bin')}${path.delimiter}${env.PATH}`, ATRIS_TOKEN: token, ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`, ATRIS_GMAIL_ACCOUNT_FILE: path.join(root, 'mail.json'), ATRIS_SKIP_UPDATE_CHECK: '1', TERM_SESSION_ID: 'google-http-test' });
  const cli = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  try { await run({ root, calls, cli }); }
  finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
const ok = (data) => [200, data];
const missing = [404, { detail: 'not found' }];
const eventArgs = ['calendar', 'add', 'private appointment', '--start', '2026-10-31T10:00:00Z', '--end', '2026-10-31T11:00:00Z'];

test('legacy scoped calendar writes refuse before creating an event', async () => {
  for (const business of [false, true]) await fixture((call) => call.path.endsWith('/google/accounts') ? missing : ok({ summary: 'private appointment', verified: true }), async ({ calls, cli }) => {
    const result = await cli(...eventArgs, ...(business ? [] : ['--account', 'work']));
    assert.notEqual(result.code, 0); assert.match(result.stderr + result.stdout, /newest atris server|newer atris server/);
    assert.equal(calls.some((call) => call.method === 'POST' && call.path.endsWith('/google-calendar/events')), false);
  }, { business });
});

test('business members can connect personal gmail without assigning the business', async () => {
  for (const role of ['member', 'owner']) await fixture((call) => {
    if (call.path.endsWith('/google/accounts')) return ok(roster);
    if (call.path.endsWith('/google/start')) return call.body.business_id && role === 'member' ? [403, { detail: 'admin only' }] : ok({ auth_url: 'https://example.test', state: 's' });
    if (call.path.endsWith('/google/start/s')) return ok({ status: 'connected', account_id: 'work', email: 'work@example.test', products: ['gmail'], missing: [] });
  }, async ({ cli, calls }) => {
    const result = await cli('gmail', 'connect', 'work');
    assert.equal(result.code, 0, result.stderr); const start = calls.find((call) => call.path.endsWith('/google/start'));
    assert.equal(start.business, 'shop'); assert.equal(Object.hasOwn(start.body, 'business_id'), false);
  }, { business: true });
});

test('obsolete or disconnected local mail choices do not block mail or the roster', async () => {
  for (const disconnected of [false, true]) await fixture((call) => {
    if (call.path.endsWith('/google/accounts')) return ok({ ...roster, accounts: disconnected ? [work, { account_id: 'retired', email: 'retired@example.test', products: { gmail: { connected: false }, calendar: { connected: true } } }] : [work], defaults: { ...roster.defaults, gmail: null } });
    if (call.path.endsWith('/google/defaults')) return [404, { detail: 'google account not found' }];
    if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
    if (call.path.endsWith('/gmail/messages')) return ok({ messages: [] });
  }, async ({ cli, calls }) => {
    assert.equal((await cli('gmail', 'inbox')).code, 0);
    assert.equal((await cli('gmail', 'accounts')).code, 0);
    assert.equal(calls.some((call) => call.path.endsWith('/google/defaults')), false);
  }, { sticky: 'retired' });
});

test('calendar sorts offset and daylight-saving instants for range and limited search', async () => fixture((call) => call.path.endsWith('/google-calendar/events') ? ok({ accounts: ['east', 'west'], errors: [], events: [
  { id: 'first', summary: 'meeting first', start: '2026-11-01T01:50:00-04:00', account_id: 'east' },
  { id: 'second', summary: 'meeting second', start: '2026-11-01T01:10:00-05:00', account_id: 'west' },
  { id: 'third', summary: 'meeting third', start: '2026-10-31T09:00:00-07:00', account_id: 'west' },
] }) : missing, async ({ cli }) => {
  const range = await cli('calendar', 'week'); assert.equal(range.code, 0); assert.ok(range.stdout.indexOf('meeting third') < range.stdout.indexOf('meeting first')); assert.ok(range.stdout.indexOf('meeting first') < range.stdout.indexOf('meeting second'));
  const search = await cli('calendar', 'search', 'meeting', '--limit', '1', '--json'); assert.equal(JSON.parse(search.stdout).matches[0].id, 'third');
}));

test('calendar json and its cache retain partial account errors', async () => {
  for (const read of [['work'], []]) { let offline = false;
    await fixture((call) => call.path.endsWith('/google-calendar/events') ? offline ? [503, { detail: 'offline' }] : ok({ accounts: read, errors: [{ account_id: 'private', code: 'reauth_required', message: 'sign in again' }], events: read.length ? [{ id: 'one', summary: 'meeting', start: '2026-10-31T10:00:00Z', account_id: 'work' }] : [] }) : missing, async ({ cli }) => {
      const live = JSON.parse((await cli('calendar', 'search', 'meeting', '--json')).stdout);
      assert.deepEqual(live.accounts, read); assert.equal(live.errors[0].account_id, 'private'); assert.equal(live.partial, true);
      offline = true; const cached = JSON.parse((await cli('calendar', 'search', 'meeting', '--json')).stdout);
      assert.equal(cached.source, 'cache'); assert.equal(cached.partial, true); assert.equal(cached.errors[0].code, 'reauth_required');
    });
  }
});

test('gmail use refuses a missing business save route on a new server', async () => fixture((call) => {
  if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
  if (call.path.endsWith('/google/accounts')) return ok(roster);
  return missing;
}, async ({ cli, root }) => {
  const result = await cli('gmail', 'use', 'work');
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /now using/); assert.equal(fs.existsSync(path.join(root, 'mail.json')), false);
}, { business: true }));

test('legacy gmail resolves email selectors before requests and saves', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return missing;
  if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
  if (call.path.endsWith('/gmail/send')) return call.body.account_id === 'work' ? ok({ sent: true }) : [403, { detail: 'wrong account' }];
  if (call.path.endsWith('/gmail/messages')) return call.query.get('account_id') === 'work' ? ok({ messages: [] }) : [403, { detail: 'wrong account' }];
}, async ({ cli, root }) => {
  const sent = await cli('gmail', 'send', 'recipient@example.test', 'subject', 'body', '--approved', '--account', 'work@example.test', '--business', 'shop'); assert.equal(sent.code, 0, sent.stderr);
  const inbox = await cli('gmail', 'inbox', '--account', 'work@example.test'); assert.equal(inbox.code, 0, inbox.stderr);
  fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: 'work@example.test' }));
  const sticky = await cli('gmail', 'inbox'); assert.equal(sticky.code, 0, sticky.stderr);
}));

test('mail roster stays available when a valid migration cannot be saved', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return ok({ ...roster, defaults: { ...roster.defaults, gmail: null } });
  if (call.path.endsWith('/google/defaults')) return [503, { detail: 'temporarily unavailable' }];
  if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
  if (call.path.endsWith('/gmail/messages')) return ok({ messages: [] });
}, async ({ cli, calls }) => {
  const listing = await cli('gmail', 'accounts'); assert.equal(listing.code, 0, listing.stderr); assert.match(listing.stdout, /work@example.test/);
  assert.equal(calls.some((call) => call.path.endsWith('/google/defaults')), false);
  const inbox = await cli('gmail', 'inbox'); assert.notEqual(inbox.code, 0);
  assert.equal(calls.some((call) => call.path.endsWith('/gmail/messages')), false);
}, { sticky: 'work' }));

test('an explicit business google sign-in assigns only when requested', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return ok(roster);
  if (call.path.endsWith('/google/start')) return ok({ auth_url: 'https://example.test', state: 's' });
  if (call.path.endsWith('/google/start/s')) return ok({ status: 'connected', account_id: 'work', email: 'work@example.test', products: ['gmail'], missing: [] });
}, async ({ cli, calls }) => {
  const result = await cli('google', 'connect', 'work', '--only', 'mail', '--business', 'shop');
  assert.equal(result.code, 0, result.stderr); assert.equal(calls.find((call) => call.path.endsWith('/google/start')).body.business_id, 'shop');
}, { business: true }));

test('legacy unscoped calendar writes still work and scoped reads refuse', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return missing;
  if (call.path.endsWith('/google-calendar/events')) return ok({ summary: 'private appointment', verified: true });
}, async ({ cli, calls }) => {
  assert.equal((await cli(...eventArgs)).code, 0);
  const read = await cli('calendar', 'week', '--account', 'work'); assert.notEqual(read.code, 0);
  assert.equal(calls.filter((call) => call.path.endsWith('/google-calendar/events')).length, 1);
}));

test('a scoped calendar response without an account is never presented as confirmed', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return ok(roster);
  if (call.path.endsWith('/google-calendar/events')) return ok({ summary: 'private appointment', verified: true });
}, async ({ cli }) => {
  const result = await cli(...eventArgs, '--account', 'work'); assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /account not reported by the server/); assert.doesNotMatch(result.stdout, /Created: private appointment \(work\)/);
}));

test('personal google use saves the canonical account name for an email selector', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return ok({ ...roster, accounts: [{ ...work, email: 'work+lab@example.test' }] });
  if (call.path.endsWith('/google/defaults')) return ok({ defaults: { gmail: 'work' } });
}, async ({ cli, root, calls }) => {
  const result = await cli('google', 'use', 'work+lab@example.test', '--only', 'mail', '--account'); assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.find((call) => call.path.endsWith('/google/defaults')).body.account_id, 'work');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mail.json'))).account_id, 'work');
}));

test('calendar json reports a complete empty response correctly', async () => fixture((call) => call.path.endsWith('/google-calendar/events') ? ok({ accounts: [], errors: [], events: [] }) : missing, async ({ cli }) => {
  const parsed = JSON.parse((await cli('calendar', 'search', 'meeting', '--json')).stdout);
  assert.deepEqual(parsed.accounts, []); assert.deepEqual(parsed.errors, []); assert.equal(parsed.partial, false); assert.equal(parsed.liveOk, true);
}));

test('an incomplete capability response cannot authorize a scoped calendar write', async () => fixture(() => ok({}), async ({ cli, calls }) => {
  const result = await cli(...eventArgs, '--account', 'work'); assert.notEqual(result.code, 0);
  assert.equal(calls.some((call) => call.method === 'POST'), false);
}));

test('old-server google use stores the short name and reports only mail', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return missing;
  if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
}, async ({ cli, root }) => {
  const result = await cli('google', 'use', 'work@example.test', '--account'); assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mail.json'))).account_id, 'work');
  assert.match(result.stdout, /mail/); assert.doesNotMatch(result.stdout, /using .*calendar/);
}));

test('calendar date-only events precede timed events and invalid dates remain last', async () => fixture((call) => call.path.endsWith('/google-calendar/events') ? ok({ accounts: ['work'], errors: [], events: [
  { id: 'invalid-a', summary: 'meeting bad a', start: 'not-a-date' },
  { id: 'timed', summary: 'meeting timed', start: '2026-11-01T12:00:00Z' },
  { id: 'allday', summary: 'meeting all day', start: { date: '2026-10-31' } },
  { id: 'invalid-b', summary: 'meeting bad b', start: 'no-date' },
] }) : missing, async ({ cli }) => {
  const parsed = JSON.parse((await cli('calendar', 'search', 'meeting', '--json')).stdout);
  assert.deepEqual(parsed.matches.map((item) => item.id), ['allday', 'timed', 'invalid-a', 'invalid-b']);
}));

test('authorization errors on the account capability do not create events', async () => fixture((call) => call.path.endsWith('/google/accounts') ? [403, { detail: 'not a member' }] : ok({}), async ({ cli, calls }) => {
  const result = await cli(...eventArgs, '--account', 'work'); assert.notEqual(result.code, 0);
  assert.equal(calls.some((call) => call.method === 'POST'), false);
}));
