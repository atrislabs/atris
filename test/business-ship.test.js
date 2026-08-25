const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  parseBusinessShipArgs,
  shipTeamNames,
  shipTaskTitle,
} = require('../commands/business');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function writeCreds(home) {
  const atrisDir = path.join(home, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'credentials.json'), JSON.stringify({
    token: 'test-token',
    provider: 'test',
    saved_at: new Date().toISOString(),
  }));
}

function startShipApi(requests, { fail = false } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      res.setHeader('Content-Type', 'application/json');
      if (fail) {
        res.statusCode = 400;
        res.end(JSON.stringify({ detail: 'description is required' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/ship') {
        res.end(JSON.stringify({
          business_id: 'biz-ship-1',
          slug: 'harbor-coffee',
          name: 'Harbor Coffee',
          agent_id: 'agent-1',
          public_page_url: 'https://atris.ai/b/harbor-coffee',
          team: [
            { name: 'Maya' },
            { display_name: 'Scout' },
            'Ops',
          ],
          seeded_task: { title: 'Write the opening offer' },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('parseBusinessShipArgs reads the paragraph and optional flags', () => {
  const parsed = parseBusinessShipArgs([
    'A neighborhood coffee cart',
    'for office mornings',
    '--name',
    'Harbor Coffee',
    '--email',
    'maya@example.com',
  ]);
  assert.deepEqual(parsed, {
    ok: true,
    description: 'A neighborhood coffee cart for office mornings',
    name: 'Harbor Coffee',
    email: 'maya@example.com',
  });

  const equals = parseBusinessShipArgs([
    'Sell weekly flower bunches',
    '--name=Bloom Club',
    '--email=hi@bloom.example',
  ]);
  assert.equal(equals.ok, true);
  assert.equal(equals.name, 'Bloom Club');
  assert.equal(equals.email, 'hi@bloom.example');

  const missing = parseBusinessShipArgs(['--name', 'Harbor Coffee']);
  assert.equal(missing.ok, false);
  assert.match(missing.usage, /atris business ship/);
});

test('ship helpers read team names and the first task title', () => {
  assert.deepEqual(
    shipTeamNames([{ display_name: 'Maya' }, { name: 'Scout' }, 'Ops']),
    ['Maya', 'Scout', 'Ops'],
  );
  assert.deepEqual(shipTeamNames({ members: [{ name: 'Maya' }] }), ['Maya']);
  assert.equal(shipTaskTitle({ title: 'Write the opening offer' }), 'Write the opening offer');
  assert.equal(shipTaskTitle('Seed the first offer'), 'Seed the first offer');
});

test('business ship --help prints ship usage without calling the api', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-help-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-help-cwd-'));
  try {
    const res = await runCli(['business', 'ship', '--help'], {
      cwd,
      env: { ...process.env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris business ship/);
    assert.match(res.stdout, /--name/);
    assert.match(res.stdout, /--email/);
    assert.doesNotMatch(res.stdout + res.stderr, /Shipping business/);
    assert.doesNotMatch(res.stdout + res.stderr, /Not logged in/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business help lists the ship subcommand', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-list-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-list-cwd-'));
  try {
    const res = await runCli(['business', '--help'], {
      cwd,
      env: { ...process.env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /ship "<paragraph>"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business ship posts the contract and prints the live summary', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-cwd-'));
  const requests = [];
  const server = await startShipApi(requests);
  writeCreds(home);
  const env = {
    ...process.env,
    HOME: home,
    ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`,
    ATRIS_SKIP_UPDATE_CHECK: '1',
  };

  try {
    const missing = await runCli(['business', 'ship', '--account'], { cwd, env });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Usage: atris business ship/);

    const loggedOutHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-out-'));
    const loggedOut = await runCli(['business', 'ship', 'A neighborhood coffee cart', '--account', '--yes'], {
      cwd,
      env: { ...env, HOME: loggedOutHome },
    });
    assert.notEqual(loggedOut.status, 0);
    assert.match(loggedOut.stderr, /Not logged in/);
    fs.rmSync(loggedOutHome, { recursive: true, force: true });

    const shipped = await runCli([
      'business',
      'ship',
      'A neighborhood coffee cart for office mornings',
      '--name',
      'Harbor Coffee',
      '--email',
      'maya@example.com',
      '--account',
      '--yes',
    ], { cwd, env });
    assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, /Harbor Coffee \(harbor-coffee\)/);
    assert.match(shipped.stdout, /Public page: https:\/\/atris\.ai\/b\/harbor-coffee/);
    assert.match(shipped.stdout, /Team: Maya, Scout, Ops/);
    assert.match(shipped.stdout, /First task: Write the opening offer/);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      method: 'POST',
      url: '/api/business/ship',
      authorization: 'Bearer test-token',
      body: {
        description: 'A neighborhood coffee cart for office mornings',
        name: 'Harbor Coffee',
        customer_email: 'maya@example.com',
      },
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business ship prints backend errors the same way create does', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-err-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-err-cwd-'));
  const requests = [];
  const server = await startShipApi(requests, { fail: true });
  writeCreds(home);
  try {
    const res = await runCli(['business', 'ship', 'A neighborhood coffee cart', '--account', '--yes'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Failed: description is required/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
