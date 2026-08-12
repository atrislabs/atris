'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  applySecretGrantEnvironment,
  childEnvironmentWithGateway,
  createPlaceholder,
  inspectRequestTarget,
  normalizeGrant,
  parseGatewaySession,
  pathMatchesGrant,
  probeListening,
  startSecretGateway,
} = require('../lib/secret-gateway');
const { reviewOnlyEngineEnvironment, runInReapedProcessGroup } = require('../lib/fleet');

const SECRET = 'Bearer real-secret-value-do-not-leak';
const GRANT_HOST = 'api.test.local';

function makeTlsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-gateway-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes',
    '-subj', `/CN=${GRANT_HOST}`,
  ], { encoding: 'utf8' });
  assert.equal(openssl.status, 0, openssl.stderr || 'openssl failed');
  return {
    dir,
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function startUpstream(fixture, handler) {
  const hits = [];
  const server = https.createServer({ key: fixture.key, cert: fixture.cert }, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        authorization: req.headers.authorization || '',
      });
      handler(req, res, hits[hits.length - 1]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        hits,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function gatewayRequest(baseUrl, { method = 'GET', path: reqPath = '/v1/items', headers = {}, rawUrl } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: 'http:',
      hostname: url.hostname,
      port: url.port,
      method,
      path: rawUrl || reqPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sampleGrant() {
  return normalizeGrant({
    id: 'fixture-ro',
    host: GRANT_HOST,
    secretEnv: 'FIXTURE_SECRET',
    pathPrefixes: ['/v1/items'],
    methods: ['GET', 'HEAD'],
    credentialHeader: 'authorization',
    placeholderEnv: 'FIXTURE_API_KEY',
    baseUrlEnv: 'FIXTURE_BASE_URL',
  });
}

function assertNoSecret(text) {
  const blob = String(text || '');
  assert.equal(blob.includes(SECRET), false, 'secret must not appear in output');
  assert.equal(blob.includes('real-secret-value'), false, 'secret fragment must not appear in output');
}

test('supervised child gets placeholder only and allowed GET reaches tls upstream with real secret', async () => {
  const fixture = makeTlsFixture();
  const upstream = await startUpstream(fixture, (_req, res) => {
    res.statusCode = 200;
    res.setHeader('set-cookie', 'session=nope');
    res.setHeader('x-ok', '1');
    res.end('ok');
  });

  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-gateway-sup-'));
  const dumpFile = path.join(controlDir, 'child-env.json');
  const receiptFile = path.join(controlDir, 'receipt.json');
  const childScript = path.join(controlDir, 'child.js');
  fs.writeFileSync(childScript, `
'use strict';
const fs = require('fs');
const http = require('http');
const dump = {
  FIXTURE_API_KEY: process.env.FIXTURE_API_KEY || '',
  FIXTURE_BASE_URL: process.env.FIXTURE_BASE_URL || '',
  FIXTURE_SECRET: process.env.FIXTURE_SECRET || '',
  ATRIS_ONE_LAP_SECRET_GATEWAY: process.env.ATRIS_ONE_LAP_SECRET_GATEWAY || '',
};
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(dump));
http.get(process.env.FIXTURE_BASE_URL + '/v1/items', {
  headers: { authorization: process.env.FIXTURE_API_KEY },
}, (res) => {
  let body = '';
  res.on('data', (c) => { body += c; });
  res.on('end', () => {
    fs.writeFileSync(${JSON.stringify(receiptFile)}, JSON.stringify({
      status: res.statusCode,
      body,
      setCookie: res.headers['set-cookie'] || null,
      xOk: res.headers['x-ok'] || null,
    }));
  });
}).on('error', (err) => {
  fs.writeFileSync(${JSON.stringify(receiptFile)}, JSON.stringify({ error: String(err) }));
  process.exit(1);
});
`);

  const env = {
    PATH: process.env.PATH,
  };
  const { placeholder } = applySecretGrantEnvironment(env, sampleGrant(), {
    upstreamPort: upstream.port,
    upstreamAddress: '127.0.0.1',
    rejectUnauthorized: false,
  });

  const previous = process.env.FIXTURE_SECRET;
  process.env.FIXTURE_SECRET = SECRET;
  let result;
  try {
    result = await runInReapedProcessGroup(
      process.execPath,
      [childScript],
      { cwd: controlDir, env, encoding: 'utf8', timeout: 15000 },
      controlDir,
      path.join(controlDir, 'sandbox-status'),
    );
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_SECRET;
    else process.env.FIXTURE_SECRET = previous;
  }

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const childEnv = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
  assert.equal(childEnv.FIXTURE_API_KEY, placeholder);
  assert.match(childEnv.FIXTURE_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(childEnv.FIXTURE_SECRET, '');
  assert.equal(childEnv.ATRIS_ONE_LAP_SECRET_GATEWAY, '');
  assertNoSecret(JSON.stringify(childEnv));

  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body, 'ok');
  assert.equal(receipt.setCookie, null);
  assert.equal(receipt.xOk, '1');
  assert.equal(upstream.hits.length, 1);
  assert.equal(upstream.hits[0].authorization, SECRET);
  assert.equal(upstream.hits[0].host, GRANT_HOST);
  assert.equal(upstream.hits[0].url, '/v1/items');

  const port = Number(new URL(childEnv.FIXTURE_BASE_URL).port);
  assert.equal(await probeListening(port), false);
  assertNoSecret(result.stdout);
  assertNoSecret(result.stderr);
  assertNoSecret(fs.readFileSync(receiptFile, 'utf8'));

  await upstream.close();
  fixture.cleanup();
  fs.rmSync(controlDir, { recursive: true, force: true });
});

test('secret gateway denies wrong placeholder method path absolute-form and host override before upstream', async () => {
  const fixture = makeTlsFixture();
  const upstream = await startUpstream(fixture, (_req, res) => {
    res.statusCode = 200;
    res.end('should-not-run');
  });
  const placeholder = createPlaceholder();
  const gateway = await startSecretGateway({
    grant: sampleGrant(),
    secret: SECRET,
    placeholder,
    upstreamPort: upstream.port,
    upstreamAddress: '127.0.0.1',
    rejectUnauthorized: false,
  });

  const cases = [
    {
      name: 'wrong placeholder',
      headers: { authorization: 'wrong', host: `127.0.0.1:${gateway.port}` },
      path: '/v1/items',
    },
    {
      name: 'wrong method',
      method: 'POST',
      headers: { authorization: placeholder, host: `127.0.0.1:${gateway.port}` },
      path: '/v1/items',
    },
    {
      name: 'wrong path',
      headers: { authorization: placeholder, host: `127.0.0.1:${gateway.port}` },
      path: '/v1/items-admin',
    },
    {
      name: 'absolute-form target',
      headers: { authorization: placeholder, host: `127.0.0.1:${gateway.port}` },
      rawUrl: 'https://evil.example/v1/items',
    },
    {
      name: 'host-header override',
      headers: { authorization: placeholder, host: 'evil.example' },
      path: '/v1/items',
    },
  ];

  for (const item of cases) {
    const response = await gatewayRequest(gateway.baseUrl, item);
    assert.ok(response.status >= 400, `${item.name} should fail`);
    assertNoSecret(response.body);
  }
  assert.equal(upstream.hits.length, 0, 'upstream must see no denied requests');
  assert.ok(gateway.receipts.every((entry) => entry.decision === 'deny'));
  assertNoSecret(JSON.stringify(gateway.receipts));

  await gateway.close();
  await upstream.close();
  fixture.cleanup();
});

test('secret gateway fails closed on upstream redirects', async () => {
  const fixture = makeTlsFixture();
  const upstream = await startUpstream(fixture, (_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', 'https://evil.example/steal');
    res.end('redirect');
  });
  const placeholder = createPlaceholder();
  const gateway = await startSecretGateway({
    grant: sampleGrant(),
    secret: SECRET,
    placeholder,
    upstreamPort: upstream.port,
    upstreamAddress: '127.0.0.1',
    rejectUnauthorized: false,
  });

  const response = await gatewayRequest(gateway.baseUrl, {
    headers: { authorization: placeholder, host: `127.0.0.1:${gateway.port}` },
    path: '/v1/items',
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.location, undefined);
  assert.equal(upstream.hits.length, 1);
  assert.ok(gateway.receipts.some((entry) => entry.reason === 'redirect'));
  assertNoSecret(response.body);
  assertNoSecret(JSON.stringify(gateway.receipts));

  await gateway.close();
  await upstream.close();
  fixture.cleanup();
});

test('review-only environment injects placeholder and never the real secret', {
  skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')
    ? 'requires macOS sandbox-exec'
    : false,
}, () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-gateway-env-'));
  spawnSync('git', ['init', '-q'], { cwd: worktree });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: worktree });
  spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/repo.git'], { cwd: worktree });

  const previous = process.env.FIXTURE_SECRET;
  process.env.FIXTURE_SECRET = SECRET;
  process.env.HTTP_PROXY = 'http://proxy.example:8080';
  let environment;
  try {
    environment = reviewOnlyEngineEnvironment(worktree, {
      engine: 'codex',
      network: true,
      secretGrant: sampleGrant(),
      secretGrantUpstreamPort: 443,
      secretGrantUpstreamAddress: '127.0.0.1',
      secretGrantRejectUnauthorized: false,
    });
    assert.ok(environment.FIXTURE_API_KEY);
    assert.notEqual(environment.FIXTURE_API_KEY, SECRET);
    assert.equal(environment.FIXTURE_SECRET, undefined);
    assert.equal(Object.values(environment).includes(SECRET), false);
    assert.equal(environment.HTTP_PROXY, '');
    assert.equal(environment.HTTPS_PROXY, '');
    assert.equal(environment.NO_PROXY, '127.0.0.1,localhost');
    const plan = JSON.parse(environment.ATRIS_ONE_LAP_SECRET_GATEWAY);
    assert.equal(plan.grant.host, GRANT_HOST);
    assert.equal(plan.placeholder, environment.FIXTURE_API_KEY);
    assertNoSecret(JSON.stringify(plan));
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_SECRET;
    else process.env.FIXTURE_SECRET = previous;
    delete process.env.HTTP_PROXY;
    if (environment && environment.ATRIS_ONE_LAP_RUNTIME_DIR) {
      fs.rmSync(environment.ATRIS_ONE_LAP_RUNTIME_DIR, { recursive: true, force: true });
    }
    if (environment && environment.ATRIS_ONE_LAP_CONTROL_DIR) {
      fs.rmSync(environment.ATRIS_ONE_LAP_CONTROL_DIR, { recursive: true, force: true });
    }
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('applySecretGrantEnvironment reserves placeholder without restoring secret values', () => {
  const env = { STRIPE_SECRET_KEY: '', PATH: '/bin' };
  const { placeholder, grant } = applySecretGrantEnvironment(env, {
    id: 'stripe-ro',
    host: 'api.stripe.com',
    secretEnv: 'STRIPE_SECRET_KEY',
    pathPrefixes: ['/v1/charges'],
    methods: ['GET', 'HEAD'],
    credentialHeader: 'authorization',
    placeholderEnv: 'STRIPE_SECRET_KEY',
    baseUrlEnv: 'STRIPE_BASE_URL',
  });
  assert.equal(env.STRIPE_SECRET_KEY, placeholder);
  assert.equal(env.HTTP_PROXY, '');
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
  assert.equal(grant.host, 'api.stripe.com');
  assert.ok(env.ATRIS_ONE_LAP_SECRET_GATEWAY);
  assert.equal(pathMatchesGrant('/v1/charges/1', grant.pathPrefixes), true);
  assert.equal(pathMatchesGrant('/v1/charges-admin', grant.pathPrefixes), false);
  assert.equal(inspectRequestTarget('/v1/charges').ok, true);
  assert.equal(inspectRequestTarget('https://evil.example/v1/charges').ok, false);
  const session = parseGatewaySession({
    grant,
    placeholder,
    secret: 'Bearer test',
  });
  const patched = childEnvironmentWithGateway({ ...env, STRIPE_SECRET_KEY: 'Bearer test' }, session, {
    baseUrl: 'http://127.0.0.1:9',
  });
  assert.equal(patched.STRIPE_BASE_URL, 'http://127.0.0.1:9');
  assert.equal(patched.STRIPE_SECRET_KEY, placeholder);
});
