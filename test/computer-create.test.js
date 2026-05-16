const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-computer-create-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeCredentials(home) {
  const atrisDir = path.join(home, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'credentials.json'), JSON.stringify({
    token: 'test-token',
    provider: 'test',
    saved_at: new Date().toISOString(),
  }), 'utf8');
}

function startApiServer(requests) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });

      function send(status, payload) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }

      if (req.method === 'GET' && req.url === '/api/business/') {
        send(200, [{ id: 'biz-1', slug: 'atris-labs', name: 'Atris Labs', workspace_id: 'ws-old' }]);
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/biz-1/workspaces') {
        send(200, {
          id: 'ws-new',
          business_id: 'biz-1',
          name: body.name,
          type: body.type,
          status: 'pending',
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/biz-1/workspaces/ws-new/activate') {
        send(200, {
          status: 'ok',
          business_id: 'biz-1',
          workspace_id: 'ws-new',
          endpoint: 'https://runner.example',
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/biz-1/ai-computer/wake') {
        send(200, {
          status: 'awake',
          business_id: 'biz-1',
          endpoint: 'https://runner.example',
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/api/business/biz-1/workspaces/ws-new/files?path=.') {
        send(200, {
          files: [{ name: 'README.md', type: 'file', size: 42 }],
        });
        return;
      }
      send(404, { detail: `unexpected ${req.method} ${req.url}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runCliAsync(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

test('computer create creates workspace, activates it, wakes it, and prints next steps', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'create',
      'My Business Computer',
      '--business',
      'atris-labs',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_APP_URL: 'http://app.local',
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Computer created: ws-new/);
    assert.match(res.stdout, /Dashboard: http:\/\/app\.local\/dashboard\/gm\/biz-1/);
    assert.match(res.stdout, /Next:/);
    assert.match(res.stdout, /atris computer --business atris-labs --workspace ws-new/);

    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ['GET', '/api/business/'],
        ['POST', '/api/business/biz-1/workspaces'],
        ['POST', '/api/business/biz-1/workspaces/ws-new/activate'],
        ['POST', '/api/business/biz-1/ai-computer/wake'],
      ]
    );
    assert.deepEqual(requests[1].body, { name: 'My Business Computer', type: 'general' });
    assert.ok(requests.every((request) => request.authorization === 'Bearer test-token'));

    const cachePath = path.join(home, '.atris', 'businesses.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache['atris-labs'].workspace_id, 'ws-new');
    assert.equal(cache['atris-labs'].computer_name, 'My Business Computer');

    const ls = await runCliAsync([
      'computer',
      'ls',
      '.',
      '--business',
      'atris-labs',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_APP_URL: 'http://app.local',
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(ls.status, 0, ls.stderr || ls.stdout);
    assert.match(ls.stdout, /README\.md/);
    assert.equal(requests.length, 5);
    assert.deepEqual(requests.at(-1), {
      method: 'GET',
      url: '/api/business/biz-1/workspaces/ws-new/files?path=.',
      authorization: 'Bearer test-token',
      body: null,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});
