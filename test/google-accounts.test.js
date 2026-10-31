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

test('google use saves the server default and local cache', async () => fixture(async (cli, { calls, root }) => {
  await cli.googleCommand('use', 'work', '--business', 'shop');
  assert.deepEqual(calls[0].options.body, { account_id: 'work' });
  assert.equal(calls[0].url, '/business/shop/integrations/google');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.atris', 'google-accounts.json'))).businesses.shop.gmail, 'work');
}, () => ok({})));

test('google disconnect chooses products and requires approval', async () => fixture(async (cli, { calls }) => {
  await cli.googleCommand('disconnect', 'work', '--only', 'mail,drive', '--approved');
  assert.equal(calls[0].url, '/integrations/google/accounts/work?products=gmail%2Cdrive');
  assert.equal(calls[0].options.method, 'DELETE');
}, () => ok({ removed: ['gmail', 'drive'], remaining: ['calendar'] })));

test('calendar reads a selected account and sorts and labels merged events', async () => fixture(async (cli, { calls, lines }) => {
  await cli.calendarCommand('week', '--account', 'all');
  assert.match(calls[0].url, /account_id=all/);
  assert.equal(calls[0].options.headers['X-Business-Id'], 'shop');
  const output = lines.join('\n'); assert.ok(output.indexOf('early') < output.indexOf('late')); assert.match(output, /one/); assert.match(output, /two/);
}, () => ok({ events: [{ summary: 'late', start: '2026-10-31T12:00:00Z', account_id: 'two' }, { summary: 'early', start: '2026-10-31T10:00:00Z', account_id: 'one' }] })));

test('old server falls back to mail accounts', async () => fixture(async (cli, { lines, calls }) => {
  await cli.googleCommand('accounts');
  assert.match(lines.join('\n'), /calendar and drive accounts need the newest atris server/);
  assert.equal(calls[1].url, '/integrations/gmail/accounts');
}, (url) => url === '/integrations/google/accounts' ? { ok: false, status: 404 } : ok([{ account_id: 'work', email_address: 'work@example.com' }])));

test('google connect requests selected products and waits for the account', async () => fixture(async (cli, { calls, lines }) => {
  await cli.googleConnect('work', ['gmail', 'calendar'], null, { openAuthUrl: () => true, sleep: async () => {}, pollIntervalMs: 1, timeoutMs: 1 });
  assert.deepEqual(calls[1].options.body, { account_id: 'work', products: ['gmail', 'calendar'] });
  assert.match(lines.join('\n'), /connected/);
}, (() => { let polls = 0; return (url) => url === '/integrations/google/start' ? ok({ auth_url: 'https://example.test', account_id: 'work' }) : ok({ accounts: ++polls === 1 ? [] : [account] }); })()));

test('personal google use saves selected products and the mail cache', async () => fixture(async (cli, { root, calls }) => {
  fs.unlinkSync(path.join(root, '.atris', 'business.json'));
  await cli.googleCommand('use', 'work', '--only', 'mail,calendar');
  assert.equal(calls[0].url, '/integrations/google/defaults');
  assert.deepEqual(calls[0].options.body, { account_id: 'work', products: ['gmail', 'calendar'] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'mail.json'))).account_id, 'work');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.atris', 'google-accounts.json'))).defaults.calendar, 'work');
}, () => ok({ defaults: { gmail: 'work', calendar: 'work' } })));

test('business mail uses the server choice and sends the business header', async () => fixture(async (cli, { calls }) => {
  await cli.gmailCommand('send', 'friend@example.com', 'hello', 'message', '--approved');
  const sent = calls.find((call) => call.url === '/integrations/gmail/send');
  assert.equal(sent.options.headers['X-Business-Id'], 'shop');
  assert.equal(Object.hasOwn(sent.options.body, 'account_id'), false);
}, (url) => url === '/integrations/google/accounts' ? ok({ resolved: { gmail: 'work' } }) : url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({ sent: true })));

test('calendar add sends the selected account in the body', async () => fixture(async (cli, { calls, lines }) => {
  await cli.calendarCommand('add', 'meeting', '--start', '2026-10-31T10:00:00Z', '--end', '2026-10-31T11:00:00Z', '--account', 'work');
  assert.equal(calls[0].options.body.account_id, 'work');
  assert.equal(calls[0].options.headers['X-Business-Id'], 'shop');
  assert.match(lines.join('\n'), /work@example.com/);
}, () => ok({ summary: 'meeting', account_id: 'work', account_email: 'work@example.com' })));

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
}, (url) => url === '/integrations/gmail/accounts' ? ok([{ account_id: 'work', email_address: 'work@example.com' }]) : ok({})));
