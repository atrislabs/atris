'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const auth = require('../utils/auth');
const { mintAgentToken, ensureBilledCommandAuth } = require('../commands/auth');

const jwt = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

test('browser login passes shell substitution literally to the real launcher process', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-browser-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(path.join(dir, 'xdg-open'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.LAUNCH_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const appUrl = 'https://atris.ai/$(true)';
  const result = spawnSync(process.execPath, ['-e', `
    require('node:os').platform = () => 'linux';
    const { getAppBaseUrl } = require('./utils/api');
    require('./utils/auth').openBrowser(getAppBaseUrl() + '/auth/cli?state=a%20b&next=%2F');
  `], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, ATRIS_APP_URL: appUrl, LAUNCH_ARGS_FILE: argsFile },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, 'browser helper must finish successfully');
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), [`${appUrl}/auth/cli?state=a%20b&next=%2F`]);
});

for (const [platform, executable, prefix] of [
  ['darwin', 'open', []],
  ['linux', 'xdg-open', []],
  ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler']],
]) {
  test(`browser login uses an argument array without a shell on ${platform}`, () => {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      require('node:os').platform = () => ${JSON.stringify(platform)};
      const cp = require('node:child_process');
      cp.exec = () => { throw new Error('browser URLs must not enter a shell'); };
      let called = false;
      cp.execFile = (file, args, callback) => {
        called = true;
        assert.equal(file, ${JSON.stringify(executable)});
        assert.deepEqual(args, [...${JSON.stringify(prefix)}, 'https://atris.ai/auth/cli?state=a&next=%22$(true)']);
        callback(null);
      };
      require('./utils/auth').openBrowser('https://atris.ai/auth/cli?state=a&next=%22$(true)');
      assert.ok(called);
    `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  });
}

async function environmentLogin(t, existing = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-env-login-security-'));
  t.mock.method(os, 'homedir', () => dir);
  for (const name of ['ATRIS_TOKEN', 'ATRIS_API_URL', 'ATRIS_PROFILE', 'ATRIS_AGENT_TOKEN_FILE', 'TERM_SESSION_ID']) {
    const before = process.env[name];
    delete process.env[name];
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = auth.getCredentialsPath();
  if (existing) auth.saveCredentials('saved-login', 'saved-refresh', 'owner@example.com', 'owner', 'google');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const profile = path.join(path.dirname(file), 'profiles', 'owner.json');
  const profileBefore = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null;
  process.env.ATRIS_TOKEN = jwt({ sub: 'environment-owner', exp: Math.floor(Date.now() / 1000) + 3600 });
  const requests = [];
  let lifetime = 3600;
  let fail = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      assert.equal(req.url, '/auth/agent-token');
      assert.equal(req.method, 'POST');
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ body, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      if (fail) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'mint denied' }));
        return;
      }
      const exp = Math.floor(Date.now() / 1000) + lifetime;
      res.end(JSON.stringify({
        access_token: jwt({ type: 'agent_access', scopes: body.scopes, exp, nonce: requests.length }),
        scopes: body.scopes,
        expires_at: new Date(exp * 1000).toISOString(),
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  process.env.ATRIS_API_URL = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    expireNext: () => { lifetime = -1; },
    failNext: () => { fail = true; },
    assertUnchanged: () => {
      assert.ok(before === null ? !fs.existsSync(file) : fs.readFileSync(file, 'utf8') === before, 'environment login must not create or change credentials.json');
      assert.ok(profileBefore === null ? !fs.existsSync(profile) : fs.readFileSync(profile, 'utf8') === profileBefore, 'environment login must not change saved profiles');
    },
  };
}

for (const existing of [false, true]) {
  test(`explicit environment token mint leaves ${existing ? 'existing credentials unchanged' : 'no credentials file'}`, async t => {
    const env = await environmentLogin(t, existing);
    const output = [];
    const status = await mintAgentToken(['--agent', '--scopes=x-search', '--json'], { output: line => output.push(line) });
    assert.equal(status, 0);
    env.assertUnchanged();
    assert.equal(JSON.parse(output.join('\n')).stored_in, 'process memory');
    assert.equal(env.requests.length, 1);
  });
}

test('billed environment login reuses the minted token for each scope in the same process', async t => {
  const env = await environmentLogin(t);
  const first = await ensureBilledCommandAuth('x-search');
  const second = await ensureBilledCommandAuth('x-search');
  const other = await ensureBilledCommandAuth('youtube');
  const again = await ensureBilledCommandAuth('x-search');
  assert.ok(first.ok && second.ok && other.ok && again.ok);
  assert.equal(first.minted, true);
  assert.equal(second.minted, false);
  assert.equal(other.minted, true);
  assert.equal(again.minted, false);
  assert.ok(first.token === second.token && first.token === again.token, 'same scope must reuse the minted token');
  assert.equal(env.requests.length, 2);
  env.assertUnchanged();
});

test('billed environment login honors forceMint and replaces the cached token', async t => {
  const env = await environmentLogin(t);
  const first = await ensureBilledCommandAuth('x-search');
  const forced = await ensureBilledCommandAuth('x-search', { forceMint: true });
  const next = await ensureBilledCommandAuth('x-search');
  assert.ok(first.ok && forced.ok && next.ok);
  assert.ok(forced.token !== first.token, 'forced mint must replace the token');
  assert.ok(next.token === forced.token, 'later calls must reuse the replacement');
  assert.equal(next.minted, false);
  assert.equal(env.requests.length, 2);
  env.assertUnchanged();
});

test('billed environment login never reuses expired tokens', async t => {
  const env = await environmentLogin(t);
  env.expireNext();
  assert.equal((await ensureBilledCommandAuth('x-search')).ok, true);
  assert.equal((await ensureBilledCommandAuth('x-search')).minted, true);
  assert.equal(env.requests.length, 2);
  env.assertUnchanged();
});

test('billed environment login keeps cached tokens bound to the login and API origin', async t => {
  const env = await environmentLogin(t);
  assert.equal((await ensureBilledCommandAuth('youtube')).ok, true);
  process.env.ATRIS_TOKEN = jwt({ sub: 'second-owner' });
  assert.equal((await ensureBilledCommandAuth('youtube')).minted, true);
  process.env.ATRIS_API_URL = process.env.ATRIS_API_URL.replace('127.0.0.1', 'localhost');
  assert.equal((await ensureBilledCommandAuth('youtube')).minted, true);
  assert.equal(env.requests.length, 3);
  env.assertUnchanged();
});

test('failed forced mint does not reuse a rejected environment token', async t => {
  const env = await environmentLogin(t);
  assert.equal((await ensureBilledCommandAuth('youtube')).ok, true);
  env.failNext();
  assert.equal((await ensureBilledCommandAuth('youtube', { forceMint: true })).ok, false);
  assert.equal((await ensureBilledCommandAuth('youtube')).ok, false);
  assert.equal(env.requests.length, 3);
  env.assertUnchanged();
});
