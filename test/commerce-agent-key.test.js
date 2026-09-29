'use strict';

// Commerce agent keys: minted with `atris login --agent --commerce`, stored in
// their own slot so x-search and YouTube mints never overwrite them, and used
// by `atris buy` / `atris transactions` when present.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { parseAgentTokenArgs, mintAgentToken } = require('../commands/auth');
const { buyCommand } = require('../commands/buy');
const { transactionsCommand } = require('../commands/transactions');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const COMMERCE_KEY = 'commerce-agent-key-secret';
const SEARCH_KEY = 'search-agent-key-secret';
const NOW = Date.parse('2026-09-29T18:00:00Z');

function jwt(claims) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`;
}

function runCli(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NONINTERACTIVE: '1', ATRIS_TOKEN: '', ATRIS_PROFILE: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('cli hung')); }, 10000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const request = { method: req.method, url: req.url, authorization: req.headers.authorization, body: text ? JSON.parse(text) : null };
      requests.push(request);
      const response = handler(request);
      res.statusCode = response.status || 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(response.body || {}));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

test('--commerce defaults to the commerce scopes; --commerce-max-usd is checked locally', () => {
  const commerce = parseAgentTokenArgs(['--agent', '--commerce', '--commerce-max-usd', '150']);
  assert.deepEqual(commerce.scopes, ['commerce:quote', 'transactions:read']);
  assert.equal(commerce.commerceMaxUsd, 150);

  const explicit = parseAgentTokenArgs(['--agent', '--scopes', 'commerce:quote', '--commerce-max-usd=$25']);
  assert.deepEqual(explicit.scopes, ['commerce:quote']);
  assert.equal(explicit.commerceMaxUsd, 25);

  assert.equal(parseAgentTokenArgs(['--agent']).commerceMaxUsd, null);
  assert.throws(() => parseAgentTokenArgs(['--agent', '--commerce', '--commerce-max-usd', '501']), /1 to 500/);
  assert.throws(() => parseAgentTokenArgs(['--agent', '--commerce', '--commerce-max-usd', '0']), /1 to 500/);
  assert.throws(() => parseAgentTokenArgs(['--agent', '--scopes', 'youtube', '--commerce-max-usd', '50']), /commerce:quote/);
});

test('commerce mint sends the cap, prints scopes and cap, and says it can never pay', async () => {
  const calls = [];
  const output = [];
  const persisted = [];
  const code = await mintAgentToken(['--agent', '--commerce', '--commerce-max-usd', '150'], {
    output: (l) => output.push(l),
    outputError: (l) => output.push(`ERR ${l}`),
    loadCredentials: () => ({ token: 'user-jwt' }),
    persistMintedAgentToken: (credentials, token, extras) => persisted.push({ token, extras }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return {
        ok: true,
        status: 200,
        data: {
          token: COMMERCE_KEY, scopes: ['commerce:quote', 'transactions:read'], daily_credit_cap: 50,
          expires_at: '2026-10-29T18:00:00+00:00', commerce_max_quote_usd: 150, commerce_daily_quotes: 50,
        },
      };
    },
  });
  assert.equal(code, 0, output.join('\n'));
  assert.equal(calls[0].pathname, '/auth/agent-token');
  assert.deepEqual(calls[0].options.body, {
    scopes: ['commerce:quote', 'transactions:read'], daily_credit_cap: 50, commerce_max_quote_usd: 150,
  });
  assert.equal(persisted[0].extras.commerceMaxUsd, 150);
  const text = output.join('\n');
  assert.match(text, /minted commerce agent key/);
  assert.match(text, /scopes: commerce:quote, transactions:read/);
  assert.match(text, /largest single quote: \$150/);
  assert.match(text, /quotes per day: 50/);
  assert.match(text, /this key can ask for prices and start your approval, it can never pay\./);
  assert.match(text, /stored in ~\/\.atris\/credentials\.json, commerce_agent_token/);
  assert.doesNotMatch(text, new RegExp(COMMERCE_KEY));
});

test('--print-key shows the key once; --json carries can_pay false', async () => {
  const deps = (output) => ({
    output: (l) => output.push(l),
    loadCredentials: () => ({ token: 'user-jwt' }),
    persistMintedAgentToken: () => {},
    apiRequestJson: async () => ({ ok: true, status: 200, data: { token: COMMERCE_KEY, scopes: ['commerce:quote'], commerce_max_quote_usd: 200 } }),
  });
  const printed = [];
  assert.equal(await mintAgentToken(['--agent', '--commerce', '--print-key'], deps(printed)), 0);
  assert.equal(printed[printed.length - 1], COMMERCE_KEY);

  const json = [];
  assert.equal(await mintAgentToken(['--agent', '--scopes', 'commerce:quote', '--json'], deps(json)), 0);
  const payload = JSON.parse(json.join('\n'));
  assert.equal(payload.can_pay, false);
  assert.equal(payload.commerce_max_quote_usd, 200);
  assert.equal('key' in payload, false);
  assert.doesNotMatch(json.join('\n'), new RegExp(COMMERCE_KEY));
});

test('live CLI: commerce key gets its own slot, and a later x-search mint leaves it alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-commerce-key-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  const credsPath = path.join(home, '.atris', 'credentials.json');
  fs.writeFileSync(credsPath, JSON.stringify({
    token: 'stored-user-jwt', refresh_token: 'stored-refresh-jwt', email: 'owner@example.com', user_id: 'u-9', provider: 'atris',
    agent_token: 'old-search-key', agent_token_scopes: ['x-search', 'youtube'], agent_token_expires_at: '2099-01-01T00:00:00Z',
  }));
  const mock = await startMock((request) => {
    const commerce = request.body.scopes.includes('commerce:quote');
    return {
      body: commerce
        ? { token: COMMERCE_KEY, scopes: request.body.scopes, daily_credit_cap: 50, expires_at: '2099-01-01T00:00:00+00:00', commerce_max_quote_usd: 75, commerce_daily_quotes: 50 }
        : { token: SEARCH_KEY, scopes: request.body.scopes, daily_credit_cap: 50, expires_at: '2099-01-01T00:00:00+00:00' },
    };
  });
  const env = { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` };
  try {
    const first = await runCli(['login', '--agent', '--commerce', '--commerce-max-usd', '75'], { cwd: dir, env });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /largest single quote: \$75/);
    assert.match(first.stdout, /it can never pay/);
    let stored = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    assert.equal(stored.token, 'stored-user-jwt');
    assert.equal(stored.agent_token, 'old-search-key', 'commerce mint must not overwrite the x-search/YouTube key');
    assert.equal(stored.commerce_agent_token, COMMERCE_KEY);
    assert.deepEqual(stored.commerce_agent_token_scopes, ['commerce:quote', 'transactions:read']);
    assert.equal(stored.commerce_max_quote_usd, 75);

    const second = await runCli(['login', '--agent'], { cwd: dir, env });
    assert.equal(second.status, 0, second.stderr);
    stored = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    assert.equal(stored.agent_token, SEARCH_KEY);
    assert.equal(stored.commerce_agent_token, COMMERCE_KEY, 'x-search mint must not overwrite the commerce key');
    assert.deepEqual(mock.requests[1].body, { scopes: ['x-search', 'youtube'], daily_credit_cap: 50 });
  } finally {
    await new Promise((r) => mock.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withCreds(creds, calls) {
  return {
    loadCredentials: () => creds,
    apiRequestJson: async (pathname, options) => {
      calls.push(options.token);
      return { ok: true, status: 200, data: { id: 'ord_1', state: 'done', transactions: [], sources: {} } };
    },
    now: () => NOW,
    log: () => {},
    err: () => {},
  };
}

test('buy and transactions use the commerce key when it has the scope, else the login', async () => {
  const future = Math.floor(NOW / 1000) + 3600;
  const past = Math.floor(NOW / 1000) - 60;
  const full = jwt({ type: 'agent_access', scopes: ['commerce:quote', 'transactions:read'], exp: future });
  const quoteOnly = jwt({ type: 'agent_access', scopes: ['commerce:quote'], exp: future });
  const expired = jwt({ type: 'agent_access', scopes: ['commerce:quote', 'transactions:read'], exp: past });

  let calls = [];
  await buyCommand(['status', 'ord_1'], withCreds({ token: 'login', commerce_agent_token: full }, calls));
  await transactionsCommand([], withCreds({ token: 'login', commerce_agent_token: full }, calls));
  assert.deepEqual(calls, [full, full]);

  calls = [];
  await buyCommand(['status', 'ord_1'], withCreds({ token: 'login', commerce_agent_token: quoteOnly }, calls));
  await transactionsCommand([], withCreds({ token: 'login', commerce_agent_token: quoteOnly }, calls));
  assert.deepEqual(calls, [quoteOnly, 'login'], 'transactions needs transactions:read');

  calls = [];
  await buyCommand(['status', 'ord_1'], withCreds({ token: 'login', commerce_agent_token: expired }, calls));
  assert.deepEqual(calls, ['login'], 'an expired commerce key falls back to the login');

  calls = [];
  await buyCommand(['status', 'ord_1'], withCreds({ token: 'login', agent_token: 'search-key' }, calls));
  assert.deepEqual(calls, ['login'], 'the x-search/YouTube key is never used for commerce');
});
