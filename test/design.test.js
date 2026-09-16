'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-design-'));
}

function cliEnv(extra = {}) {
  return {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NONINTERACTIVE: '1',
    ATRIS_TOKEN: '',
    ATRIS_PROFILE: '',
    ATRIS_API_KEY: 'test-design-key',
    ATRIS_DESIGN_POLL_MS: '25',
    ...extra,
  };
}

function runCli(args, { cwd, env, timeout = 15000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: cliEnv(env),
  });
  if (result.error) throw result.error;
  return result;
}

function runCliAsync(args, { cwd, env, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: cliEnv(env),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`cli hung past ${timeout}ms (args: ${args.join(' ')})`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function startHttpMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      const request = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      };
      requests.push(request);
      Promise.resolve()
        .then(() => handler(request))
        .catch((error) => ({ status: 500, body: { error: String(error.message || error) } }))
        .then((response) => {
          res.statusCode = response?.status || 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(response?.body || {}));
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const completedExtraction = {
  id: 'job-1',
  status: 'completed',
  source_url: 'https://stripe.com',
  error: null,
  credits_charged: 10,
  result: {
    design_system: {
      profile: { brand_name: 'Stripe', one_line_positioning: 'payments infra' },
      colors: {
        primary: '#635bff',
        secondary: '#00d4ff',
        accent: '#4285f4',
        palette: [
          { hex: '#000000', role: 'Primary Text', usage_share: 0.4 },
          { hex: '#ffffff', role: 'Background', usage_share: 0.2 },
        ],
      },
      typography: {
        heading: { family: 'Stripe Sans (Custom) / System Sans' },
        body: { family: 'Inter, sans-serif', size: '16px' },
      },
    },
  },
  atris: { credits_charged: 10, cost_usd: 0.1, balance_remaining_usd: 42.5 },
};

test('atris design extract polls the job and prints the card', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  let polls = 0;
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions' && request.method === 'POST') {
      assert.equal(request.authorization, 'Bearer test-design-key');
      assert.deepEqual(request.body, { url: 'https://stripe.com' });
      return { status: 202, body: { id: 'job-1', status: 'accepted' } };
    }
    if (request.url.startsWith('/api/design/extractions/job-1')) {
      polls += 1;
      if (polls === 1) return { status: 200, body: { id: 'job-1', status: 'running' } };
      return { status: 200, body: completedExtraction };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['design', 'extract', 'https://stripe.com'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.ok(polls >= 2, `expected the polling loop to run, got ${polls} poll(s)`);
    assert.match(res.stdout, /Stripe/);
    assert.match(res.stdout, /#635bff/);
    assert.match(res.stdout, /#00d4ff/);
    assert.match(res.stdout, /Stripe Sans \(Custom\) \/ System Sans/);
    assert.match(res.stdout, /Inter, sans-serif/);
    assert.match(res.stdout, /10 credits charged\. \$42\.50 left\./);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design extract --json prints the raw job', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions') {
      return { status: 200, body: { ...completedExtraction, cached: true } };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['design', 'extract', 'stripe.com', '--json'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.result.design_system.profile.brand_name, 'Stripe');
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design extract sends sections on the post and the poll url', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions' && request.method === 'POST') {
      assert.deepEqual(request.body, { url: 'https://stripe.com', sections: 'colors,typography' });
      return { status: 202, body: { id: 'job-7', status: 'accepted' } };
    }
    if (request.url.startsWith('/api/design/extractions/job-7')) {
      assert.equal(request.url, '/api/design/extractions/job-7?sections=colors%2Ctypography');
      return { status: 200, body: completedExtraction };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(
      ['design', 'extract', 'https://stripe.com', '--sections', 'colors,typography'],
      { cwd: dir, env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` } },
    );
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design check posts both urls, polls, and prints the score', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  let polls = 0;
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/adherence' && request.method === 'POST') {
      assert.equal(request.authorization, 'Bearer test-design-key');
      assert.deepEqual(request.body, {
        source_url: 'https://example.com',
        reference_url: 'https://stripe.com',
      });
      return { status: 202, body: { id: 'job-9', status: 'accepted' } };
    }
    if (request.url === '/api/design/adherence/job-9') {
      polls += 1;
      if (polls === 1) return { status: 200, body: { id: 'job-9', status: 'running' } };
      return {
        status: 200,
        body: {
          id: 'job-9',
          status: 'completed',
          source_url: 'https://example.com',
          reference_url: 'https://stripe.com',
          result: {
            score: 0.82,
            fixes: [{ title: 'raise contrast on muted text' }],
            recommendations: [],
          },
          atris: { credits_charged: 20, balance_remaining_usd: 42.3 },
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(
      ['design', 'check', 'https://example.com', '--against', 'https://stripe.com'],
      { cwd: dir, env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` } },
    );
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.ok(polls >= 2, `expected polling, got ${polls} poll(s)`);
    assert.match(res.stdout, /0\.82/);
    assert.match(res.stdout, /against   https:\/\/stripe\.com/);
    assert.match(res.stdout, /raise contrast on muted text/);
    assert.match(res.stdout, /20 credits charged/);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design search posts the query with limit and prints results', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/search' && request.method === 'POST') {
      assert.equal(request.authorization, 'Bearer test-design-key');
      assert.deepEqual(request.body, { query: 'developer tools', limit: 2 });
      return {
        status: 200,
        body: {
          results: [
            {
              extraction_id: 'x1',
              brand_name: 'Supabase',
              source_url: 'https://supabase.com',
              palette: ['#3ecf8e', '#ffffff'],
            },
          ],
          atris: { credits_charged: 1, balance_remaining_usd: 42.49 },
        },
      };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(
      ['design', 'search', 'developer tools', '--limit', '2'],
      { cwd: dir, env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` } },
    );
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /1 result for "developer tools"/);
    assert.match(res.stdout, /Supabase  https:\/\/supabase\.com/);
    assert.match(res.stdout, /#3ecf8e/);
    assert.match(res.stdout, /1 credit charged\. \$42\.49 left\./);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design extract passes the api 401 message through', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions' && request.method === 'POST') {
      return { status: 401, body: { detail: 'invalid api key' } };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['design', 'extract', 'https://stripe.com'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` },
    });
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /design extract failed \(401\): invalid api key/);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design search passes the api 402 message through', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/search' && request.method === 'POST') {
      return { status: 402, body: { detail: 'out of credits. top up at atris.ai' } };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['design', 'search', 'developer tools'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` },
    });
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /design search failed \(402\): out of credits\. top up at atris\.ai/);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design extract gives up after the poll window and keeps the job id', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions' && request.method === 'POST') {
      return { status: 202, body: { id: 'job-4', status: 'accepted' } };
    }
    if (request.url === '/api/design/extractions/job-4') {
      return { status: 200, body: { id: 'job-4', status: 'running' } };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['design', 'extract', 'https://stripe.com'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
        ATRIS_DESIGN_TIMEOUT_MS: '900',
        ATRIS_DESIGN_POLL_MS: '50',
      },
    });
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /still running after \d+s\. job id: job-4/);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design extract reports a failed job', async () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  const mock = await startHttpMock((request) => {
    if (request.url === '/api/design/extractions' && request.method === 'POST') {
      return { status: 202, body: { id: 'job-5', status: 'accepted' } };
    }
    if (request.url === '/api/design/extractions/job-5') {
      return { status: 200, body: { id: 'job-5', status: 'failed', error: 'extractor crashed' } };
    }
    return { status: 404, body: { error: `unexpected ${request.url}` } };
  });

  try {
    const res = await runCliAsync(['design', 'extract', 'https://stripe.com'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api` },
    });
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /extraction did not finish: extractor crashed/);
  } finally {
    await closeServer(mock.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design extract with no key prints one plain sentence', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  try {
    const res = runCli(['design', 'extract', 'https://stripe.com'], {
      cwd: dir,
      env: { HOME: home, ATRIS_API_KEY: '' },
    });
    assert.equal(res.status, 1, res.stderr);
    const text = `${res.stdout}\n${res.stderr}`;
    assert.match(text, /no api key found\. set ATRIS_API_KEY or run: atris login/);
    assert.match(text, /~\/\.atris\/design-api-key/);
    assert.doesNotMatch(text, /test-design-key/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris design help lists the three subcommands', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['design', '--help'], { cwd: dir, env: { HOME: path.join(dir, 'home') } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /design extract/);
    assert.match(res.stdout, /design check/);
    assert.match(res.stdout, /design search/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
