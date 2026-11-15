const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('./helpers/business-cli');

const {
  parseBusinessShipArgs,
  shipTeamNames,
  shipTaskTitle,
} = require('../commands/business');

function writeCreds(home) {
  const atrisDir = path.join(home, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'credentials.json'), JSON.stringify({
    token: 'test-token',
    provider: 'test',
    saved_at: new Date().toISOString(),
  }));
}

function startShipApi(requests, { fail = false, hireResult, hireStatus = 200 } = {}) {
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
      if (req.method === 'POST' && /\/hire\/template$/.test(req.url)) {
        res.statusCode = hireStatus;
        res.end(JSON.stringify(hireResult || { hired: Array.from({ length: 6 }, (_, i) => ({ name: `Seat ${i + 1}`, next_run_at: 'tomorrow' })), failed: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/') {
        res.end(JSON.stringify({ id: 'biz-1', slug: 'test-business', name: 'Test Business' }));
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
    assert.match(res.stdout, /--kind/);
    assert.match(res.stdout, /--kind engineering --yes/);
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
    assert.match(res.stdout, /--kind/);
    const createHelp = await runCli(['business', 'create', '--help'], { cwd, env: { ...process.env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.match(createHelp.stdout, /--kind/);
    assert.match(createHelp.stdout, /--kind engineering --yes/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business ship without --yes does not post', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-noyes-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-ship-noyes-cwd-'));
  const requests = [];
  const server = await startShipApi(requests);
  writeCreds(home);
  try {
    const res = await runCli(['business', 'ship', 'A neighborhood coffee cart', '--account'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    assert.match(res.stderr, /Pass --yes to create a live business/);
    assert.doesNotMatch(res.stdout + res.stderr, /Shipping business/);
    assert.equal(requests.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
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


test('business create and ship send a valid kind and reject invalid kinds before requests', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-kind-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-kind-cwd-'));
  const requests = [];
  const server = await startShipApi(requests);
  writeCreds(home);
  const env = { ...process.env, HOME: home, ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`, ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    for (const command of ['create', 'ship']) {
      const base = command === 'create'
        ? ['business', 'create', 'Test Business', '--force', '--no-local', '--account']
        : ['business', 'ship', 'Test Business', '--yes', '--account'];
      const invalid = await runCli([...base, '--kind', 'wrong'], { cwd, env });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /business, research, engineering, or fund/);
      assert.equal(requests.length, 0);
      const missing = await runCli([...base, '--kind'], { cwd, env });
      assert.notEqual(missing.status, 0);
      assert.equal(requests.length, 0);
      const noKind = await runCli(base, { cwd, env });
      assert.equal(noKind.status, 0, noKind.stderr || noKind.stdout);
      assert.equal(Object.hasOwn(requests[0].body, 'template'), false);
      requests.length = 0;
      const withKind = await runCli([...base, '--kind=engineering'], { cwd, env });
      assert.equal(withKind.status, 0, withKind.stderr || withKind.stdout);
      assert.equal(requests[0].body.template, 'engineering');
      assert.equal(requests.length, 2);
      assert.equal(requests[1].url, command === 'create' ? '/api/business/biz-1/hire/template' : '/api/business/biz-ship-1/hire/template');
      assert.deepEqual(requests[1].body, { template: 'engineering' });
      assert.match(withKind.stdout, /6 of 6 seats set up/);
      assert.match(withKind.stdout, /Seat 1: next run tomorrow/);
      requests.length = 0;
      const skipped = await runCli([...base, '--kind', 'engineering', '--no-hire'], { cwd, env });
      assert.equal(skipped.status, 0);
      assert.equal(requests.length, 1);
      assert.match(skipped.stdout, /Team: engineering \(six seats\)/);
      requests.length = 0;
      const scheduled = await runCli([...base, '--kind', 'engineering', '--schedule', 'weekly'], { cwd, env });
      assert.equal(scheduled.status, 0);
      assert.deepEqual(requests[1].body, { template: 'engineering', schedule: 'weekly' });
      assert.doesNotMatch(scheduled.stdout, /runs nightly/);
      requests.length = 0;
      for (const option of [['--no-hire'], ['--schedule', 'weekly']]) {
        const refused = await runCli([...base, ...option], { cwd, env });
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /need --kind/);
        assert.equal(requests.length, 0);
      }
      requests.length = 0;
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});


test('hire failures report the existing business and preserve partial success', async () => {
  for (const scenario of [
    { hireResult: { hired: [{ name: 'Maya' }], failed: [{ name: 'Scout', detail: 'email unavailable' }] }, status: 0, pattern: /Scout: email unavailable/ },
    { hireResult: { hired: [], failed: [{ name: 'Scout', detail: 'email unavailable' }] }, status: 1, pattern: /business exists/i },
    { hireStatus: 403, hireResult: { detail: 'not allowed' }, status: 1, pattern: /business was created, but the team was not set up: not allowed/i },
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hire-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hire-cwd-'));
    const requests = [];
    const server = await startShipApi(requests, scenario);
    writeCreds(home);
    try {
      const env = { ...process.env, HOME: home, ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`, ATRIS_SKIP_UPDATE_CHECK: '1' };
      const result = await runCli(['business', 'ship', 'Test Business', '--yes', '--account', '--kind', 'business'], { cwd, env });
      assert.equal(result.status, scenario.status, result.stderr);
      assert.match(result.stderr, scenario.pattern);
      if (scenario.hireResult.failed) assert.match(result.stderr, /hire step again is safe/);
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});
