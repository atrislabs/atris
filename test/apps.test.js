const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const { findAppsPackRoot, listAppManifests } = require('../commands/apps');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function makePack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-test-'));
  const pack = path.join(root, 'atris', 'apps-pack');
  const app = path.join(pack, 'apps', 'demo-app');
  fs.mkdirSync(path.join(pack, 'scripts'), { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(pack, 'scripts', 'app_use.py'), '# test\n');
  fs.writeFileSync(path.join(app, 'APP.md'), `---
schema_version: 1
name: Demo App
slug: demo-app
description: Demo metadata.
runtime: local
secrets: []
surfaces:
  - cli
---

# Demo App
`);
  return { root, pack };
}

function writeArgvScript(pack, name) {
  fs.writeFileSync(
    path.join(pack, 'scripts', name),
    [
      '#!/usr/bin/env python3',
      'import json',
      'import sys',
      'print(json.dumps({"argv": sys.argv[1:]}))',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

function makeHomeWithCredentials(token = 'test-token') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-home-'));
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
    token,
    refresh_token: null,
    email: 'apps@example.com',
    user_id: 'user-apps',
    provider: 'test',
    saved_at: new Date().toISOString(),
  }), 'utf8');
  return home;
}

function startJsonServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function spawnCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('findAppsPackRoot discovers atris/apps-pack from nested workspace paths', () => {
  const { root, pack } = makePack();
  const nested = path.join(root, 'services', 'api');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findAppsPackRoot(nested), pack);
});

test('listAppManifests returns agent-readable APP.md metadata', () => {
  const { pack } = makePack();
  assert.deepEqual(listAppManifests(pack), [{
    slug: 'demo-app',
    path: path.join(pack, 'apps', 'demo-app', 'APP.md'),
    latest_output: path.join(pack, 'apps', 'demo-app', 'data', 'latest.md'),
    schema_version: 1,
    name: 'Demo App',
    description: 'Demo metadata.',
    runtime: 'local',
    secrets: [],
    surfaces: ['cli'],
  }]);
});

test('atris apps list --json bypasses natural-language planner', () => {
  const { root, pack } = makePack();
  const result = spawnSync(process.execPath, [cliPath, 'apps', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_APPS_PACK: pack, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.pack, pack);
  assert.equal(payload.apps[0].slug, 'demo-app');
});

test('atris apps --json is a machine-readable list shorthand', () => {
  const { root, pack } = makePack();
  const result = spawnSync(process.execPath, [cliPath, 'apps', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_APPS_PACK: pack, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.pack, pack);
  assert.equal(payload.apps[0].slug, 'demo-app');
});

test('atris apps --json missing pack returns JSON error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-test-'));
  const result = spawnSync(process.execPath, [cliPath, 'apps', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_APPS_PACK: path.join(root, 'missing-pack'), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: 'No Atris app pack found.',
    expected: 'atris/apps-pack/ in this workspace, or ATRIS_APPS_PACK',
  });
});

test('atris apps load --json fetches owned cloud apps without a local pack', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-test-'));
  const home = makeHomeWithCredentials();
  const requests = [];
  const { server, port } = await startJsonServer((req, res) => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    if (req.url === '/api/auth/validate' && req.method === 'POST') {
      sendJson(res, 200, { valid: true, user: { email: 'apps@example.com', id: 'user-apps' } });
      return;
    }
    if (req.url === '/api/apps?filter=template' && req.method === 'GET') {
      sendJson(res, 200, {
        apps: [
          {
            id: 'app-1',
            name: 'Morning Brief',
            slug: 'morning-brief',
            description: 'Daily briefing app.',
            template: 'briefing',
            status: 'ready',
          },
        ],
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  try {
    const result = await spawnCli([
      'apps',
      'load',
      '--filter',
      'template',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_APPS_PACK: path.join(root, 'missing-pack'),
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.source, 'cloud');
    assert.equal(payload.filter, 'template');
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.apps[0], {
      id: 'app-1',
      name: 'Morning Brief',
      slug: 'morning-brief',
      description: 'Daily briefing app.',
      template: 'briefing',
      status: 'ready',
      last_run: null,
      next_run: null,
    });
    assert.deepEqual(requests.map(r => r.url), ['/api/auth/validate', '/api/apps?filter=template']);
    assert.equal(requests[1].authorization, 'Bearer test-token');
  } finally {
    server.close();
  }
});

test('atris apps load --json returns login guidance without credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-apps-home-'));
  const result = spawnSync(process.execPath, [cliPath, 'apps', 'load', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ATRIS_APPS_PACK: path.join(root, 'missing-pack'),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: 'Not logged in. Run: atris login',
    login: 'atris login',
  });
});

test('atris apps run --json missing slug returns JSON usage error', () => {
  const { root, pack } = makePack();
  const result = spawnSync(process.execPath, [cliPath, 'apps', 'run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_APPS_PACK: pack, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: 'Usage: atris apps run <slug> [--workspace <path>] [--lines N]',
  });
});

test('atris apps owner --json missing slug returns JSON usage error', () => {
  const { root, pack } = makePack();
  const result = spawnSync(process.execPath, [cliPath, 'apps', 'owner', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_APPS_PACK: pack, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: 'Usage: atris apps owner <slug> [--workspace <path>] [--lines N]',
  });
});

test('atris apps unknown --json returns JSON usage error', () => {
  const { root, pack } = makePack();
  const result = spawnSync(process.execPath, [cliPath, 'apps', 'nope', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_APPS_PACK: pack, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'Unknown apps command: nope');
  assert.ok(payload.usage.some(line => line.includes('atris apps <command>')));
});

test('atris apps owner forwards json, no-run, and line limit', () => {
  const { root, pack } = makePack();
  writeArgvScript(pack, 'app_owner.py');
  const result = spawnSync(
    process.execPath,
    [cliPath, 'apps', 'owner', 'demo-app', '--json', '--no-run', '--lines', '7'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ATRIS_APPS_PACK: pack, ATRIS_SKIP_UPDATE_CHECK: '1' } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ['demo-app', '--workspace', fs.realpathSync(root), '--lines', '7', '--json', '--no-run'],
  });
});
