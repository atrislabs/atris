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

async function fixture(handler, run, { business = false, sticky, provisioned = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-http-test-'));
  fs.mkdirSync(path.join(root, 'atris')); fs.mkdirSync(path.join(root, '.atris')); fs.mkdirSync(path.join(root, 'bin'));
  if (business) fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ business_id: 'shop' }));
  if (provisioned) fs.writeFileSync(path.join(root, '.atris', 'agent-token.json'), '{}');
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
  const runCli = (input, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), ...args], { cwd: root, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (input !== null) child.stdin.end(input);
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const cli = (...args) => runCli(null, args);
  const cliInput = (input, ...args) => runCli(input, args);
  try { await run({ root, calls, cli, cliInput }); }
  finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
const ok = (data) => [200, data];
const missing = [404, { detail: 'not found' }];
const eventArgs = ['calendar', 'add', 'private appointment', '--start', '2026-10-31T10:00:00Z', '--end', '2026-10-31T11:00:00Z'];

test('legacy reconnect with an unchanged account remains unconfirmed', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return missing;
  if (call.path.endsWith('/gmail/start')) return ok({ auth_url: 'https://example.test/unfinished' });
  if (call.path.endsWith('/gmail/accounts')) return ok({ accounts: [{ account_id: 'work', email_address: 'work@example.test', connected: false, reauth_required: true }] });
}, async ({ cli, calls }) => {
  const result = await cli('google', 'connect', 'work', '--only', 'mail');
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^connected /m);
  assert.match(result.stdout, /not confirmed yet/);
  assert.match(result.stdout, /atris gmail accounts/);
  assert.ok(calls.some((call) => call.path.endsWith('/gmail/start')));
}, { business: true }));

for (const scenario of ['new account', 'reconnected account', 'renamed account', 'unknown prior account', 'still disconnected']) {
  test(`legacy sign-in checks the prior account before reporting ${scenario}`, async () => {
    let lists = 0;
    await fixture((call) => {
      if (call.path.endsWith('/google/accounts')) return missing;
      if (call.path.endsWith('/gmail/start')) return ok({ auth_url: 'https://example.test/sign-in' });
      if (call.path.endsWith('/gmail/accounts')) {
        lists += 1;
        if (scenario === 'unknown prior account' && lists === 1) return [503, { detail: 'offline' }];
        if (scenario === 'new account' && lists === 1) return ok({ accounts: [] });
        const prior = lists === 1;
        const row = { account_id: 'work', email_address: 'work@example.test' };
        if (scenario === 'reconnected account') Object.assign(row, { connected: !prior, reauth_required: prior });
        if (scenario === 'renamed account') row.display_name = prior ? 'before' : 'after';
        if (scenario === 'still disconnected') Object.assign(row, { connected: false, reauth_required: true });
        return ok({ accounts: [row] });
      }
    }, async ({ cli, calls }) => {
      const result = await cli('google', 'connect', 'work', '--only', 'mail');
      assert.equal(result.code, 0, result.stderr);
      if (['new account', 'reconnected account'].includes(scenario)) assert.match(result.stdout, /^connected work@example.test as work/m);
      else { assert.doesNotMatch(result.stdout, /^connected /m); assert.match(result.stdout, /not confirmed yet/); }
      const before = calls.findIndex((call) => call.path.endsWith('/gmail/accounts'));
      const start = calls.findIndex((call) => call.path.endsWith('/gmail/start'));
      assert.ok(before >= 0 && before < start);
    }, { business: true });
  });
}

test('reconnect commands from text and json run in a personal project', async () => {
  let requested = [];
  await fixture((call) => {
    if (call.path.endsWith('/google/accounts')) return ok({ ...roster, business: null, accounts: [{ ...work, products: Object.fromEntries(['gmail', 'calendar', 'drive'].map((product) => [product, { connected: false, reauth_required: true }])) }] });
    if (call.path.endsWith('/google/start')) { requested = call.body.products; return ok({ auth_url: 'https://example.test', state: 'reconnect-state' }); }
    if (call.path.endsWith('/google/start/reconnect-state')) return ok({ status: 'connected', account_id: 'work', email: 'work@example.test', products: requested, missing: [] });
  }, async ({ cli, calls }) => {
    const listing = await cli('google', 'accounts'); assert.equal(listing.code, 0, listing.stderr);
    const json = await cli('google', 'accounts', '--json'); assert.equal(json.code, 0, json.stderr);
    const products = JSON.parse(json.stdout).accounts[0].products;
    for (const [key, label] of [['gmail', 'mail'], ['calendar', 'calendar'], ['drive', 'drive']]) {
      const textCommand = listing.stdout.split('\n').find((line) => line.trim().startsWith(`reconnect ${label}: `)).split(': ').slice(1).join(': ');
      for (const command of [textCommand, products[key].reconnect]) {
        const words = command.trim().split(/\s+/); assert.equal(words.shift(), 'atris');
        const result = await cli(...words); assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^connected /m);
        const start = calls.filter((call) => call.path.endsWith('/google/start')).at(-1);
        assert.deepEqual(start.body.products, [key]);
        assert.equal(Object.hasOwn(start.body, 'business_id'), false);
        assert.equal(start.business, null);
      }
    }
  });
});

for (const command of ['google', 'gmail']) test(`${command} sign-in with expired state never claims an unrelated account change`, async () => {
  let lists = 0;
  await fixture((call) => {
    if (call.path.endsWith('/google/accounts')) return ok({ ...roster, accounts: [{ ...work, display_name: ++lists === 1 ? 'before' : 'after' }] });
    if (call.path.endsWith('/google/start')) return ok({ auth_url: 'https://example.test', state: 'expired', account_id: 'work' });
    if (call.path.endsWith('/google/start/expired')) return [404, { detail: 'Invalid or expired Google sign-in' }];
  }, async ({ cli, calls }) => {
    const result = await cli(command, 'connect', 'work');
    assert.equal(result.code, 1); assert.match(result.stderr, /sign-in expired/);
    assert.match(result.stderr, /atris google connect work/); assert.doesNotMatch(result.stdout, /^connected/m);
    assert.equal(calls.filter((call) => call.path.endsWith('/google/accounts')).length, 1);
    assert.equal(calls.filter((call) => call.path.endsWith('/google/start/expired')).length, 1);
  }, { provisioned: true });
});

test('google account json and text show each reconnecting product', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return ok({ ...roster, accounts: [{ ...work, products: {
    gmail: { connected: false, reauth_required: true }, calendar: { connected: false, reauth_required: true }, drive: { connected: false, reauth_required: true },
  } }] });
}, async ({ cli }) => {
  const text = await cli('google', 'accounts'); assert.equal(text.code, 0);
  assert.doesNotMatch(text.stdout, /no products/);
  for (const product of ['mail', 'calendar', 'drive']) {
    assert.match(text.stdout, new RegExp(`${product} needs reconnecting`));
    assert.match(text.stdout, new RegExp(`atris google connect work --only ${product}`));
  }
  for (const args of [['google', 'accounts', '--json'], ['google', '--json']]) {
    const result = await cli(...args); assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.accounts[0].products.gmail.reconnect, 'atris google connect work --only mail --account');
    assert.equal(data.accounts[0].products.calendar.reauth_required, true);
    assert.equal(data.accounts[0].products.drive.connected, false);
  }
}));

test('google accounts json keeps older-server mail fallback parseable', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return missing;
  if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
}, async ({ cli }) => {
  const result = await cli('google', 'accounts', '--json'); assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.legacy, true); assert.equal(data.accounts[0].account_id, 'work');
  assert.match(data.notice, /newest atris server/);
}));

for (const selectorType of ['name', 'email']) for (const reversed of [false, true]) for (const target of ['business', 'personal', 'legacy']) {
  test(`exact ${selectorType} wins over a display label for ${target}, reversed ${reversed}`, async () => {
    const selector = selectorType === 'name' ? 'work' : 'work@example.test';
    const personal = { account_id: 'default', email: 'personal@example.test', display_name: selector, products: { gmail: { connected: true } } };
    const selected = { ...work, display_name: 'company' };
    const accounts = reversed ? [selected, personal] : [personal, selected];
    await fixture((call) => {
      if (call.path.endsWith('/gmail/accounts')) return ok(accounts);
      if (call.path.endsWith('/google/accounts')) return target === 'legacy' ? missing : ok({ ...roster, accounts });
      if (call.method === 'PUT') return ok({ account_id: 'work' });
    }, async ({ cli, calls, root }) => {
      const result = await cli('gmail', 'use', selector);
      assert.equal(result.code, 0, result.stderr);
      if (target === 'legacy') {
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mail.json'))).account_id, 'work');
      } else {
        const saved = calls.find((call) => call.method === 'PUT');
        assert.equal(saved.body.account_id, 'work');
        const cache = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'google-accounts.json')));
        if (target === 'business') assert.equal(cache.businesses.shop.gmail, 'work');
        else { assert.equal(cache.defaults.gmail, 'work'); assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mail.json'))).account_id, 'work'); }
      }
    }, { business: target === 'business', provisioned: target !== 'business' });
  });
}

test('ambiguous display labels refuse to change a choice and list the matches', async () => {
  const accounts = [
    { account_id: 'one', email: 'one@example.test', display_name: 'team' },
    { account_id: 'two', email: 'two@example.test', display_name: 'team' },
  ];
  for (const legacy of [false, true]) await fixture((call) => {
    if (call.path.endsWith('/gmail/accounts')) return ok(accounts);
    if (call.path.endsWith('/google/accounts')) return legacy ? missing : ok({ ...roster, accounts });
    if (call.method === 'PUT') return ok({});
  }, async ({ cli, calls, root }) => {
    const result = await cli('gmail', 'use', 'team');
    assert.notEqual(result.code, 0); assert.match(result.stderr, /ambiguous/i);
    assert.match(result.stderr, /one@example\.test/); assert.match(result.stderr, /two@example\.test/);
    assert.equal(calls.some((call) => call.method === 'PUT'), false);
    assert.equal(fs.existsSync(path.join(root, 'mail.json')), false);
  }, { provisioned: true });
});

test('the interactive gmail selection saves the chosen row despite a display collision', async () => {
  const accounts = [
    { account_id: 'default', email: 'personal@example.test', display_name: 'work' },
    { ...work, display_name: 'company' },
  ];
  await fixture((call) => {
    if (call.path.endsWith('/gmail/accounts')) return ok(accounts);
    if (call.path.endsWith('/google/accounts')) return ok({ ...roster, accounts });
    if (call.method === 'PUT') return ok({});
  }, async ({ cliInput, calls }) => {
    const result = await cliInput('2\n', 'gmail', 'use');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.find((call) => call.method === 'PUT').body.account_id, 'work');
  }, { provisioned: true });
});

test('legacy google use resolves exact selectors before colliding display labels', async () => {
  for (const selector of ['work', 'work@example.test']) for (const reverse of [false, true]) {
    const accounts = [
      { account_id: 'default', email: 'personal@example.test', display_name: selector },
      { ...work, display_name: 'company' },
    ];
    if (reverse) accounts.reverse();
    await fixture((call) => {
      if (call.path.endsWith('/google/accounts')) return missing;
      if (call.path.endsWith('/gmail/accounts')) return ok(accounts);
    }, async ({ cli, root }) => {
      const result = await cli('google', 'use', selector, '--account');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mail.json'))).account_id, 'work');
    });
  }
});

test('legacy google use refuses ambiguous display labels', async () => fixture((call) => {
  if (call.path.endsWith('/google/accounts')) return missing;
  if (call.path.endsWith('/gmail/accounts')) return ok([
    { account_id: 'one', email: 'one@example.test', display_name: 'team' },
    { account_id: 'two', email: 'two@example.test', display_name: 'team' },
  ]);
}, async ({ cli, root }) => {
  const result = await cli('google', 'use', 'team', '--account');
  assert.notEqual(result.code, 0); assert.match(result.stderr, /ambiguous/);
  assert.match(result.stderr, /one@example\.test/); assert.match(result.stderr, /two@example\.test/);
  assert.equal(fs.existsSync(path.join(root, 'mail.json')), false);
}));

for (const status of [403, 404]) {
  test(`scoped calendar search prints a json error when preflight returns ${status}`, async () => fixture((call) => {
    if (call.path.endsWith('/google/accounts')) return [status, { detail: status === 403 ? 'not a business member' : 'not found' }];
    return ok({ events: [] });
  }, async ({ cli, calls }) => {
    const result = await cli('calendar', 'search', 'meeting', '--json', '--account', 'work');
    assert.notEqual(result.code, 0);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.ok, false); assert.equal(packet.query, 'meeting'); assert.equal(packet.status, status);
    assert.match(packet.error, status === 403 ? /not a business member/ : /newest atris server/);
    assert.deepEqual(packet.matches, []);
    assert.equal(calls.some((call) => call.path.endsWith('/google-calendar/events')), false);
  }));
}

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

test('gmail use caches the whole business choice after a successful assignment', async () => fixture((call) => {
  if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
  if (call.path.endsWith('/google/accounts')) return ok(roster);
  if (call.path.endsWith('/business/shop/integrations/google')) return ok({ account_id: 'work' });
}, async ({ cli, root }) => {
  const result = await cli('gmail', 'use', 'work'); assert.equal(result.code, 0, result.stderr);
  const cache = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'google-accounts.json')));
  assert.deepEqual(cache.businesses.shop, { gmail: 'work', calendar: 'work', drive: 'work' });
}, { business: true }));

test('legacy email migration saves the canonical short name on the server', async () => {
  let saved = false;
  await fixture((call) => {
    if (call.path.endsWith('/google/accounts')) return ok({ ...roster, defaults: { ...roster.defaults, gmail: saved ? 'work' : null } });
    if (call.path.endsWith('/google/defaults')) { saved = true; return ok({ defaults: { gmail: 'work' } }); }
    if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
    if (call.path.endsWith('/gmail/messages')) return ok({ messages: [] });
  }, async ({ cli, calls }) => {
    const result = await cli('gmail', 'inbox'); assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.find((call) => call.path.endsWith('/google/defaults')).body.account_id, 'work');
  }, { sticky: 'work@example.test' });
});

test('a denied business save never falls back to a local choice', async () => fixture((call) => {
  if (call.path.endsWith('/gmail/accounts')) return ok(oldMail);
  if (call.path.endsWith('/google/accounts')) return ok(roster);
  if (call.path.endsWith('/business/shop/integrations/google')) return [403, { detail: 'not allowed' }];
}, async ({ cli, root }) => {
  const result = await cli('gmail', 'use', 'work'); assert.notEqual(result.code, 0);
  assert.equal(fs.existsSync(path.join(root, 'mail.json')), false); assert.doesNotMatch(result.stdout, /now using/);
}, { business: true }));
