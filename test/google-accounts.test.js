'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function fixture(run, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-accounts-'));
  const oldCwd = process.cwd();
  const oldHome = process.env.HOME;
  const oldFile = process.env.ATRIS_GMAIL_ACCOUNT_FILE;
  const auth = require.resolve('../utils/auth');
  const api = require.resolve('../utils/api');
  const integration = require.resolve('../commands/integrations');
  const saved = [require.cache[auth], require.cache[api], require.cache[integration]];
  const calls = [], lines = [];
  const log = console.log;
  fs.mkdirSync(path.join(root, '.atris'));
  fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ business_id: 'shop' }));
  process.chdir(root);
  process.env.HOME = root;
  process.env.ATRIS_GMAIL_ACCOUNT_FILE = path.join(root, 'mail.json');
  require.cache[auth] = { id: auth, filename: auth, loaded: true, exports: { loadCredentials: () => ({ token: 'token' }), ensureValidCredentials: async () => ({ credentials: { token: 'token' } }) } };
  require.cache[api] = { id: api, filename: api, loaded: true, exports: { apiRequestJson: async (url, options) => { calls.push({ url, options }); return handler(url, options); } } };
  delete require.cache[integration];
  console.log = (...parts) => lines.push(parts.join(' '));
  try { await run(require(integration), { root, calls, lines }); }
  finally {
    console.log = log; process.chdir(oldCwd); process.env.HOME = oldHome;
    if (oldFile === undefined) delete process.env.ATRIS_GMAIL_ACCOUNT_FILE; else process.env.ATRIS_GMAIL_ACCOUNT_FILE = oldFile;
    for (const [i, key] of [auth, api, integration].entries()) { if (saved[i]) require.cache[key] = saved[i]; else delete require.cache[key]; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const account = { account_id: 'work', email: 'work@example.com', products: { gmail: { connected: true }, calendar: { connected: true }, drive: { connected: false } } };
const ok = (data) => ({ ok: true, status: 200, data });

test('google lists products, defaults and business', async () => fixture(async (cli, { calls, lines }) => {
  await cli.googleCommand('accounts');
  assert.match(lines.join('\n'), /work@example.com/); assert.match(lines.join('\n'), /calendar/); assert.match(lines.join('\n'), /business.*work/);
  assert.equal(calls[0].options.headers['X-Business-Id'], 'shop');
}, () => ok({ accounts: [account], defaults: { gmail: 'work', calendar: 'work', drive: null }, business: { business_id: 'shop', account_id: 'work' } })));

test('google accounts shows reconnect commands for products that need sign-in', async () => fixture(async (cli, { lines }) => {
  await cli.googleCommand('accounts');
  const output = lines.join('\n');
  assert.match(output, /mail.*needs reconnecting/);
  assert.match(output, /calendar.*needs reconnecting/);
  assert.match(output, /atris google connect work --only mail/);
  assert.match(output, /atris google connect work --only calendar/);
  assert.match(output, /drive/);
  assert.doesNotMatch(output, /no products/);
}, () => ok({ accounts: [{ ...account, products: { gmail: { connected: false, reauth_required: true }, calendar: { connected: false, reauth_required: true }, drive: { connected: true } } }], defaults: {}, resolved: {} })));

test('google accounts json includes reconnect state and commands for all expired products', async () => fixture(async (cli, { lines }) => {
  await cli.googleCommand('accounts', '--json');
  const data = JSON.parse(lines.join('\n'));
  const products = data.accounts[0].products;
  for (const [key, label] of [['gmail', 'mail'], ['calendar', 'calendar'], ['drive', 'drive']]) {
    assert.equal(products[key].reauth_required, true);
    assert.equal(products[key].connected, false);
    assert.equal(products[key].reconnect, `atris google connect work --only ${label} --account`);
  }
  assert.equal(data.defaults.gmail, 'work');
}, () => ok({ accounts: [{ ...account, products: Object.fromEntries(['gmail', 'calendar', 'drive'].map((key) => [key, { connected: false, reauth_required: true }])) }], defaults: { gmail: 'work' }, resolved: {} })));

test('expired products alone are never reported as no products', async () => fixture(async (cli, { lines }) => {
  await cli.googleCommand('accounts');
  assert.doesNotMatch(lines.join('\n'), /no products/);
  assert.match(lines.join('\n'), /mail.*needs reconnecting/);
}, () => ok({ accounts: [{ ...account, products: { gmail: { connected: false, reauth_required: true } } }], defaults: {}, resolved: {} })));

for (const command of ['google', 'gmail']) test(`${command} connect refuses an expired sign-in even if the account changes`, async () => fixture(async (cli, { calls, lines }) => {
  const exit = process.exit, error = console.error, errors = [];
  process.exit = () => { throw new Error('stopped'); }; console.error = (...parts) => errors.push(parts.join(' '));
  const deps = { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 2 };
  try {
    await assert.rejects(() => command === 'google' ? cli.googleConnect('work', ['gmail'], null, deps) : cli.gmailConnectUnified('work', deps), /stopped/);
  } finally { process.exit = exit; console.error = error; }
  assert.match(errors.join('\n'), /sign-in expired/);
  assert.match(errors.join('\n'), /atris google connect work/);
  assert.doesNotMatch(lines.join('\n'), /^connected/m);
  assert.equal(calls.filter((call) => call.url === '/integrations/google/accounts').length, 1);
  assert.equal(calls.filter((call) => call.url === '/integrations/google/start/expired').length, 1);
}, (() => { let count = 0; return (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', account_id: 'work', state: 'expired' }) : url.endsWith('/start/expired') ? { ok: false, status: 404 } : ok({ accounts: [{ ...account, display_name: ++count === 1 ? 'old' : 'changed' }] }); })()));

test('google use saves the server default and local cache', async () => fixture(async (cli, { calls, root }) => {
  await cli.googleCommand('use', 'work', '--business', 'shop');
  const saved = calls.find((call) => call.url === '/business/shop/integrations/google');
  assert.deepEqual(saved.options.body, { account_id: 'work' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.atris', 'google-accounts.json'))).businesses.shop.gmail, 'work');
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account] }) : ok({})));

test('google disconnect chooses products and requires approval', async () => fixture(async (cli, { calls }) => {
  await cli.googleCommand('disconnect', 'work', '--only', 'mail,drive', '--approved');
  assert.equal(calls[0].url, '/integrations/google/accounts/work?products=gmail%2Cdrive');
  assert.equal(calls[0].options.method, 'DELETE');
}, () => ok({ removed: ['gmail', 'drive'], remaining: ['calendar'] })));

test('calendar reads a selected account and sorts and labels merged events', async () => fixture(async (cli, { calls, lines }) => {
  await cli.calendarCommand('week', '--account', 'all');
  const read = calls.find((call) => call.url.startsWith('/integrations/google-calendar/events'));
  assert.match(read.url, /account_id=all/);
  assert.equal(read.options.headers['X-Business-Id'], 'shop');
  const output = lines.join('\n'); assert.ok(output.indexOf('early') < output.indexOf('late')); assert.match(output, /one/); assert.match(output, /two/);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account] }) : ok({ events: [{ summary: 'late', start: '2026-10-31T12:00:00Z', account_id: 'two' }, { summary: 'early', start: '2026-10-31T10:00:00Z', account_id: 'one' }] })));

test('old server falls back to mail accounts', async () => fixture(async (cli, { lines, calls }) => {
  await cli.googleCommand('accounts');
  assert.match(lines.join('\n'), /calendar and drive accounts need the newest atris server/);
  assert.equal(calls[1].url, '/integrations/gmail/accounts');
}, (url) => url === '/integrations/google/accounts' ? { ok: false, status: 404 } : ok([{ account_id: 'work', email_address: 'work@example.com' }])));

test('google connect requests selected products and waits for its sign-in state', async () => fixture(async (cli, { calls, lines }) => {
  await cli.googleConnect('work', ['gmail', 'calendar'], null, { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1 });
  assert.deepEqual(calls[1].options.body, { account_id: 'work', products: ['gmail', 'calendar'] });
  assert.match(lines.join('\n'), /connected/);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', account_id: 'work', state: 'state1' }) : url.endsWith('/start/state1') ? ok({ status: 'connected', account_id: 'work', email: 'work@example.com', products: ['gmail', 'calendar'] }) : ok({ accounts: [account] })));

test('personal google use saves selected products and the mail cache', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  await cli.googleCommand('use', 'work', '--only', 'mail,calendar');
  const saved = calls.find((call) => call.url === '/integrations/google/defaults');
  assert.deepEqual(saved.options.body, { account_id: 'work', products: ['gmail', 'calendar'] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mail.json'))).account_id, 'work');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.atris', 'google-accounts.json'))).defaults.calendar, 'work');
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account] }) : ok({ defaults: { gmail: 'work', calendar: 'work' } })));

test('business mail uses the server choice and sends the business header', async () => fixture(async (cli, { calls }) => {
  await cli.gmailCommand('send', 'friend@example.com', 'hello', 'message', '--approved');
  const sent = calls.find((call) => call.url === '/integrations/gmail/send');
  assert.equal(sent.options.headers['X-Business-Id'], 'shop');
  assert.equal(Object.hasOwn(sent.options.body, 'account_id'), false);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: 'work' }, resolved: { gmail: 'work' } }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ sent: true })));

test('calendar add sends the selected account in the body', async () => fixture(async (cli, { calls, lines }) => {
  await cli.calendarCommand('add', 'meeting', '--start', '2026-10-31T10:00:00Z', '--end', '2026-10-31T11:00:00Z', '--account', 'work');
  const created = calls.find((call) => call.url === '/integrations/google-calendar/events');
  assert.equal(created.options.body.account_id, 'work');
  assert.equal(created.options.headers['X-Business-Id'], 'shop');
  assert.match(lines.join('\n'), /work@example.com/);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account] }) : ok({ summary: 'meeting', account_id: 'work', account_email: 'work@example.com' })));

test('disconnect refuses before calling the server without approval', async () => fixture(async (cli, { calls }) => {
  await assert.rejects(() => cli.googleCommand('disconnect', 'work'), /needs --approved/);
  assert.equal(calls.length, 0);
}, () => ok({})));

test('business product choices cannot misrepresent a whole business selection', async () => fixture(async (cli, { calls }) => {
  await assert.rejects(() => cli.googleCommand('use', 'work', '--only', 'mail'), /one account for all products/);
  assert.equal(calls.length, 0);
}, () => ok({})));

test('old server disconnect uses the named mail account only', async () => fixture(async (cli, { calls, lines }) => {
  await cli.googleCommand('disconnect', 'work@example.com', '--only', 'mail', '--approved');
  assert.equal(calls.at(-1).url, '/integrations/gmail?account_id=work');
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(lines.filter((line) => line.includes('newest atris server')).length, 1);
}, (url) => url.startsWith('/integrations/google/') ? { ok: false, status: 404 } : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({})));

test('new server missing account does not fall back to mail deletion', async () => fixture(async (cli, { calls }) => {
  const exit = process.exit; const error = console.error;
  process.exit = () => { throw new Error('stopped'); }; console.error = () => {};
  try { await assert.rejects(() => cli.googleCommand('disconnect', 'missing', '--approved'), /stopped/); }
  finally { process.exit = exit; console.error = error; }
  assert.equal(calls.some((call) => call.url.startsWith('/integrations/gmail?')), false);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [] }) : { ok: false, status: 404 }));


test('bare google command accepts a business option', async () => fixture(async (cli, { calls }) => {
  await cli.googleCommand('--business', 'other');
  assert.equal(calls[0].options.headers['X-Business-Id'], 'other');
}, () => ok({ accounts: [], defaults: {} })));

test('gmail use saves its mail default on the server', async () => fixture(async (cli, { calls }) => {
  await cli.gmailCommand('use', 'work');
  const saved = calls.find((call) => call.url === '/business/shop/integrations/google');
  assert.deepEqual(saved.options.body, { account_id: 'work' });
  assert.equal(saved.options.headers['X-Business-Id'], 'shop');
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account] }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({})));

test('personal mail follows the server default without sending a selector', async () => fixture(async (cli, { root, calls, lines }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: 'old' }));
  await cli.gmailCommand('inbox');
  const read = calls.find((call) => call.url.startsWith('/integrations/gmail/messages?'));
  assert.equal(new URLSearchParams(read.url.split('?')[1]).has('account_id'), false);
  assert.match(lines.join('\n'), /work@example.com/);
  assert.equal(calls.some((call) => call.url === '/integrations/google/defaults'), false);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: 'work' }, resolved: { gmail: 'work' } }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ messages: [] })));

test('moves the old mail choice once only when the server has no saved default', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: 'work' }));
  await cli.gmailCommand('inbox');
  await cli.gmailCommand('inbox');
  const saves = calls.filter((call) => call.url === '/integrations/google/defaults');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].options.body, { account_id: 'work', products: ['gmail'] });
  assert.equal(saves[0].options.headers, undefined);
  const reads = calls.filter((call) => call.url.startsWith('/integrations/gmail/messages?'));
  assert.ok(reads.every((call) => !new URLSearchParams(call.url.split('?')[1]).has('account_id')));
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: null }, resolved: { gmail: 'work' } }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ messages: [] })));

test('mail sends use the server choice while an explicit account still wins', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  await cli.gmailCommand('send', 'friend@example.com', 'hello', 'message', '--approved');
  await cli.gmailCommand('send', 'friend@example.com', 'hello', 'message', '--approved', '--account', 'work');
  const sent = calls.filter((call) => call.url === '/integrations/gmail/send');
  assert.equal(Object.hasOwn(sent[0].options.body, 'account_id'), false);
  assert.equal(sent[1].options.body.account_id, 'work');
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: 'work' }, resolved: { gmail: 'work' } }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ sent: true })));

test('old server keeps the local mail selector without extra output', async () => fixture(async (cli, { root, calls, lines }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: 'work' }));
  await cli.gmailCommand('inbox');
  assert.match(calls.find((call) => call.url.startsWith('/integrations/gmail/messages?')).url, /account_id=work/);
  assert.doesNotMatch(lines.join('\n'), /newest atris server/);
}, (url) => url === '/integrations/google/accounts' ? { ok: false, status: 404 } : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ messages: [] })));

test('connect waits for its state and reports the products Google did not grant', async () => fixture(async (cli, { calls, lines }) => {
  await cli.googleConnect('work', ['gmail', 'calendar', 'drive'], null, { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 2 });
  assert.equal(calls.filter((call) => call.url === '/integrations/google/start/state%2F1').length, 2);
  assert.match(lines.join('\n'), /connected work@example.com/);
  assert.match(lines.join('\n'), /did not grant: drive/);
}, (() => { let polls = 0; return (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', account_id: 'work', state: 'state/1' }) : url.startsWith('/integrations/google/start/') ? ok(++polls === 1 ? { status: 'pending' } : { status: 'connected', account_id: 'work', email: 'work@example.com', products: ['gmail', 'calendar'], missing: ['drive'] }) : ok({ accounts: [account] }); })()));

test('connect reports a denied sign-in without claiming success', async () => fixture(async (cli, { lines }) => {
  const exit = process.exit, error = console.error, errors = [];
  process.exit = () => { throw new Error('stopped'); }; console.error = (...parts) => errors.push(parts.join(' '));
  try { await assert.rejects(() => cli.googleConnect('work', ['gmail'], null, { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1 }), /stopped/); }
  finally { process.exit = exit; console.error = error; }
  assert.match(errors.join('\n'), /denied/);
  assert.doesNotMatch(lines.join('\n'), /^connected/m);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', account_id: 'work', state: 'state1' }) : url.startsWith('/integrations/google/start/') ? ok({ status: 'error', error: 'access_denied' }) : ok({ accounts: [] })));

test('unfinished google sign-in names the account and remaining products and business uncertainty', async () => fixture(async (cli) => {
  const exit = process.exit, error = console.error, errors = [];
  process.exit = () => { throw new Error('stopped'); }; console.error = (...parts) => errors.push(parts.join(' '));
  try { await assert.rejects(() => cli.googleConnect('work', null, 'shop', { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1 }), /stopped/); }
  finally { process.exit = exit; console.error = error; }
  const output = errors.join('\n');
  assert.match(output, /fresh/); assert.match(output, /drive.*(remain|still|stayed)|(?:remain|still|stayed).*drive/i);
  assert.match(output, /business.*(may|unknown|uncertain)/i);
  assert.match(output, /atris google accounts --business shop/);
  assert.match(output, /could not finish: business/);
  assert.match(output, /could not be undone/);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', state: 'state1' }) : url.endsWith('/state1') ? ok({ status: 'error', error: 'connection_failed', account_id: 'fresh', products: ['drive'], failed: ['business'], cleanup_incomplete: true, business_assignment_unknown: true }) : ok({ accounts: [] })));

test('a superseded google sign-in explains unknown products and what to do next', async () => fixture(async (cli) => {
  const exit = process.exit, error = console.error, errors = [];
  process.exit = () => { throw new Error('stopped'); }; console.error = (...parts) => errors.push(parts.join(' '));
  try { await assert.rejects(() => cli.googleConnect('work', null, null, { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1 }), /stopped/); }
  finally { process.exit = exit; console.error = error; }
  const output = errors.join('\n');
  assert.doesNotMatch(output, /superseded/i);
  assert.match(output, /newer|another/i); assert.match(output, /products.*unknown|unknown.*products/i);
  assert.match(output, /business.*(may|unknown|uncertain)/i); assert.match(output, /atris google accounts/);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', state: 'state1' }) : url.endsWith('/state1') ? ok({ status: 'error', error: 'superseded', cleanup_incomplete: true, business_assignment_unknown: true }) : ok({ accounts: [] })));

for (const products of [null, []]) test(`unfinished sign-in distinguishes ${products === null ? 'unknown' : 'no'} remaining products`, async () => fixture(async (cli) => {
  const exit = process.exit, error = console.error, errors = [];
  process.exit = () => { throw new Error('stopped'); }; console.error = (...parts) => errors.push(parts.join(' '));
  try { await assert.rejects(() => cli.googleConnect('work', null, null, { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1 }), /stopped/); }
  finally { process.exit = exit; console.error = error; }
  const output = errors.join('\n');
  assert.match(output, products === null ? /products.*unknown|unknown.*products/i : /no products.*(remain|still)|(?:remain|still).*no products/i);
  assert.match(output, /fresh/); assert.match(output, /mail/);
  assert.doesNotMatch(output, /business.*may/i);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', state: 'state1' }) : url.endsWith('/state1') ? ok({ status: 'error', error: 'connection_failed', account_id: 'fresh', products, failed: ['gmail'], cleanup_incomplete: true }) : ok({ accounts: [] })));

test('business mail migration refreshes the server choice before displaying and sending', async () => fixture(async (cli, { root, calls, lines }) => {
  fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: 'work' }));
  await cli.gmailCommand('send', 'friend@example.com', 'hello', 'message', '--approved');
  const sent = calls.find((call) => call.url === '/integrations/gmail/send');
  assert.equal(Object.hasOwn(sent.options.body, 'account_id'), false);
  assert.match(lines.join('\n'), /work@example.com/);
  assert.equal(calls.filter((call) => call.url === '/integrations/google/accounts').length, 2);
}, (() => { let saved = false; return (url) => {
  if (url === '/integrations/google/defaults') { saved = true; return ok({ defaults: { gmail: 'work' } }); }
  if (url === '/integrations/google/accounts') return ok({ accounts: [account], defaults: { gmail: saved ? 'work' : null }, resolved: { gmail: saved ? 'work' : 'old' }, business: { business_id: 'shop', account_id: null } });
  if (url === '/integrations/gmail/accounts') return ok([{ account_id: 'work', email_address: 'work@example.com' }, { account_id: 'old', email_address: 'old@example.com' }]);
  return ok({ sent: true });
}; })()));

test('a saved server default wins even if it is later cleared', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: 'old' }));
  await cli.gmailCommand('inbox');
  await cli.gmailCommand('inbox');
  assert.equal(calls.some((call) => call.url === '/integrations/google/defaults'), false);
}, (() => { let seen = 0; return (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: ++seen === 1 ? 'work' : null }, resolved: { gmail: 'work' } }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ messages: [] }); })()));

test('a modern sign-in without state cannot claim a connection', async () => fixture(async (cli, { calls, lines }) => {
  await assert.rejects(() => cli.googleConnect('work', ['gmail'], null, { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1 }), /sign-in state/);
  assert.equal(calls.filter((call) => call.url === '/integrations/google/accounts').length, 1);
  assert.doesNotMatch(lines.join('\n'), /^connected/m);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', account_id: 'work' }) : ok({ accounts: [account] })));

test('a missing modern start route uses the old gmail sign-in', async () => fixture(async (cli, { calls, lines }) => {
  await cli.googleConnect('work', ['gmail'], null, { openAuthUrl: () => true, sleep: async () => {}, pollIntervalMs: 1, timeoutMs: 1 });
  assert.ok(calls.some((call) => call.url === '/integrations/gmail/start'));
  assert.match(lines.join('\n'), /not confirmed yet/);
  assert.match(lines.join('\n'), /newest atris server/);
}, (url) => url === '/integrations/google/start' ? { ok: false, status: 404 } : url === '/integrations/gmail/start' ? ok({ auth_url: 'https://example.test' }) : url === '/integrations/gmail/accounts' ? ok({ accounts: [{ account_id: 'work', email: 'work@example.com' }] }) : ok({ accounts: [account] })));

test('gmail combined sign-in polls its state', async () => fixture(async (cli, { calls, lines }) => {
  await cli.gmailConnectUnified('work', { openAuthUrl: () => true, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1 });
  assert.deepEqual(calls.find((call) => call.url === '/integrations/google/start').options.body.products, ['gmail']);
  assert.match(lines.join('\n'), /connected work@example.com/);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', account_id: 'work', state: 'gmail-state' }) : url === '/integrations/google/start/gmail-state' ? ok({ status: 'connected', account_id: 'work', email: 'work@example.com', products: ['gmail'], missing: [] }) : ok({ accounts: [account] })));

test('calendar without a selector lets the server choose', async () => fixture(async (cli, { calls }) => {
  await cli.calendarCommand('week');
  await cli.calendarCommand('add', 'meeting', '--start', '2026-10-31T10:00:00Z', '--end', '2026-10-31T11:00:00Z');
  const read = calls.find((call) => call.url.startsWith('/integrations/google-calendar/events?'));
  const created = calls.find((call) => call.url === '/integrations/google-calendar/events');
  assert.equal(new URLSearchParams(read.url.split('?')[1]).has('account_id'), false);
  assert.equal(Object.hasOwn(created.options.body, 'account_id'), false);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account] }) : ok({ events: [] })));

test('a failed default migration stops mail before it can choose the wrong account', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  fs.writeFileSync(path.join(root, 'mail.json'), JSON.stringify({ account_id: 'work' }));
  const exit = process.exit, error = console.error;
  process.exit = () => { throw new Error('stopped'); }; console.error = () => {};
  try { await assert.rejects(() => cli.gmailCommand('inbox'), /stopped/); }
  finally { process.exit = exit; console.error = error; }
  assert.equal(calls.some((call) => call.url.startsWith('/integrations/gmail/')), false);
  assert.equal(fs.existsSync(path.join(root, 'mail.json.migrated')), false);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: null }, resolved: { gmail: 'work' } }) : { ok: false, status: 503 }));

test('gmail combined sign-in keeps the old sign-in on an old server', async () => fixture(async (cli, { calls, lines }) => {
  await cli.gmailConnectUnified('work', { openAuthUrl: () => true, sleep: async () => {}, pollIntervalMs: 1, timeoutMs: 1 });
  assert.ok(calls.some((call) => call.url === '/integrations/gmail/start'));
  assert.match(lines.join('\n'), /not confirmed yet/);
  assert.doesNotMatch(lines.join('\n'), /newest atris server/);
}, (url) => url === '/integrations/google/accounts' ? { ok: false, status: 404 } : url === '/integrations/gmail/start' ? ok({ auth_url: 'https://example.test' }) : ok({ accounts: [{ account_id: 'work', email_address: 'work@example.com' }] })));

test('sign-in status stops after its time limit', async () => fixture(async (cli, { calls }) => {
  const exit = process.exit, error = console.error;
  let time = 0;
  process.exit = () => { throw new Error('stopped'); }; console.error = () => {};
  try { await assert.rejects(() => cli.googleConnect('work', ['gmail'], null, { openAuthUrl: () => true, sleep: async (ms) => { time += ms; }, now: () => time, pollIntervalMs: 2, timeoutMs: 5 }), /stopped/); }
  finally { process.exit = exit; console.error = error; }
  assert.equal(time, 5);
  assert.equal(calls.filter((call) => call.url === '/integrations/google/start/state1').length, 2);
}, (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', state: 'state1' }) : url.endsWith('/state1') ? ok({ status: 'pending' }) : ok({ accounts: [] })));

test('a newly saved local copy is not migrated after the server default is cleared', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  await cli.googleCommand('use', 'work', '--only', 'mail');
  await cli.gmailCommand('inbox');
  assert.equal(calls.filter((call) => call.url === '/integrations/google/defaults').length, 1);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: null }, resolved: { gmail: 'work' } }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ defaults: { gmail: 'work' }, messages: [] })));

test('mail read and archive let the server select an account', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  await cli.gmailCommand('read', 'message-1');
  await cli.gmailCommand('archive', 'message-1');
  const read = calls.find((call) => call.url.startsWith('/integrations/gmail/messages/message-1'));
  const archive = calls.find((call) => call.url === '/integrations/gmail/messages/batch-archive');
  assert.equal(new URLSearchParams(read.url.split('?')[1] || '').has('account_id'), false);
  assert.equal(Object.hasOwn(archive.options.body, 'account_id'), false);
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account], defaults: { gmail: 'work' }, resolved: { gmail: 'work' } }) : url.includes('batch-archive') ? ok({ archived: 1 }) : ok({ body: 'hello' })));

test('an explicit email selector is accepted for sending', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  await cli.gmailCommand('send', 'friend@example.com', 'hello', 'message', '--approved', '--account', 'work@example.com');
  assert.equal(calls.find((call) => call.url === '/integrations/gmail/send').options.body.account_id, 'work');
}, (url) => url === '/integrations/google/accounts' ? ok({ accounts: [account] }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ sent: true })));
