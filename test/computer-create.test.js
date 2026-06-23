const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  contextForAttachedWorkspaceMismatch,
  extractAttachedWorkspaceMismatch,
} = require('../commands/computer');

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
  let lastChatMessage = '';
  let emptyDeltaReplayServed = false;
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
      if (req.method === 'GET' && req.url === '/api/business/biz-1/workspaces') {
        send(200, [
          { id: 'ws-old', business_id: 'biz-1', name: 'Main', type: 'general', status: 'active', is_default: true },
          { id: 'ws-new', business_id: 'biz-1', name: 'My Business Computer', type: 'general', status: 'active', is_default: false },
          { id: 'ws-recruiting', business_id: 'biz-1', name: 'Recruiting Computer', type: 'recruiting', status: 'active', is_default: false },
          { id: 'ws-mismatch', business_id: 'biz-1', name: 'Mismatch', type: 'general', status: 'active', is_default: false },
        ]);
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/') {
        const slug = String(body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        send(200, {
          id: 'biz-created',
          slug,
          name: body.name,
          workspace_id: 'ws-created',
          agent_id: 'agent-created',
        });
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
      if (req.method === 'POST' && req.url === '/api/business/biz-1/workspaces/ws-old/activate') {
        send(200, {
          status: 'ok',
          business_id: 'biz-1',
          workspace_id: 'ws-old',
          endpoint: 'https://runner.example',
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/biz-1/ai-computer/wake') {
        send(200, {
          status: 'running',
          business_id: 'biz-1',
          endpoint: 'https://runner.example',
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/api/business/biz-1/ai-computer/status') {
        send(200, {
          status: 'running',
          business_id: 'biz-1',
          endpoint: 'https://runner.example',
          attached_workspace_id: 'ws-new',
          attached_workspace_name: 'My Business Computer',
          attached_by: 'operator-1',
          attached_at: '2026-05-19T09:00:00+00:00',
          lease_age_seconds: 120,
          takeover_hint: 'Use --force to take over Main.',
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/biz-1/chat') {
        lastChatMessage = String(body?.message || '');
        send(200, {
          execution_id: 'exec-1',
          session_id: 'session-1',
        });
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/business/biz-1/chat/events?')) {
        if (lastChatMessage.includes('FAIL_STREAM')) {
          send(200, { status: 'failed', events: [{ type: 'error', error: 'stream failed for test' }] });
          return;
        }
        if (lastChatMessage.includes('EMPTY_DELTA_REFETCH')) {
          if (!emptyDeltaReplayServed) {
            emptyDeltaReplayServed = true;
            send(200, { status: 'completed', events: [], next_index: 2 });
            return;
          }
          send(200, { status: 'completed', events: [{ type: 'assistant_text', content: 'RECOVERED_RESULT' }, { type: 'complete' }], next_index: 2 });
          return;
        }
        const reply = lastChatMessage.includes('CHAT_OK') ? 'CHAT_OK' : '4';
        send(200, { status: 'completed', events: [{ type: 'assistant_text', content: reply }, { type: 'complete' }] });
        return;
      }
      if (
        req.method === 'POST' &&
        (
          req.url === '/api/business/biz-1/workspaces/ws-new/terminal' ||
          req.url === '/api/business/biz-1/workspaces/ws-old/terminal' ||
          req.url === '/api/business/biz-1/workspaces/ws-recruiting/terminal' ||
          req.url === '/api/business/biz-1/workspaces/ws-mismatch/terminal'
        )
      ) {
        if (req.url.includes('/ws-mismatch/')) {
          send(409, { detail: 'AI computer is attached to workspace ws-old. Activate workspace ws-mismatch to switch.' });
          return;
        }
        const command = String(body?.command || '');
        if (command.includes('ATRIS_STATUS_OK')) {
          send(200, { stdout: 'ATRIS_STATUS_OK\n', exit_code: 0 });
          return;
        }
        send(200, {
          stdout: 'atris_runtime_bootstrap install=installed_latest version=atris v3.15.31 sync=synced receipt=.atris/state/runtime.json\n',
          exit_code: 0,
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/business/biz-1/ai-computer/sleep') {
        send(200, {
          status: 'sleeping',
          business_id: 'biz-1',
          service_name: 'svc-biz-1',
        });
        return;
      }
      if (req.method === 'DELETE' && req.url === '/api/business/biz-1/workspaces/ws-new') {
        send(200, { status: 'deleted' });
        return;
      }
      if (
        req.method === 'GET' &&
        (
          req.url === '/api/business/biz-1/workspaces/ws-new/files?path=.' ||
          req.url === '/api/business/biz-1/workspaces/ws-old/files?path=.'
        )
      ) {
        send(200, {
          files: [{ name: 'README.md', type: 'file', size: 42 }],
        });
        return;
      }
      if (
        req.method === 'GET' &&
        (
          req.url === '/api/business/biz-1/workspaces/ws-new/file?path=README.md' ||
          req.url === '/api/business/biz-1/workspaces/ws-old/file?path=README.md'
        )
      ) {
        send(200, { content: '# Atris\n' });
        return;
      }
      send(404, { detail: `unexpected ${req.method} ${req.url}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runCliAsync(args, { cwd, env, input = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
    if (input !== null) child.stdin.end(input);
  });
}

test('computer proof can parse active workspace mismatch errors', () => {
  const message = 'AI computer is attached to workspace 51803cee-f153-4ac1-9cd4-eab97fd4aa3a. Activate workspace 89e8432e-e796-4e7b-9a40-e536c454fa9a to switch.';

  assert.deepEqual(extractAttachedWorkspaceMismatch(message), {
    attachedWorkspaceId: '51803cee-f153-4ac1-9cd4-eab97fd4aa3a',
    requestedWorkspaceId: '89e8432e-e796-4e7b-9a40-e536c454fa9a',
  });
  assert.equal(extractAttachedWorkspaceMismatch('plain failure'), null);
});

test('computer proof can retry against attached workspace context', () => {
  const ctx = {
    businessId: 'biz-1',
    businessName: 'Atris Labs',
    workspaceId: '89e8432e-e796-4e7b-9a40-e536c454fa9a',
  };
  const failure = {
    result: { error: 'bad request' },
    fallback: {
      error: 'AI computer is attached to workspace 51803cee-f153-4ac1-9cd4-eab97fd4aa3a. Activate workspace 89e8432e-e796-4e7b-9a40-e536c454fa9a to switch.',
    },
  };

  assert.deepEqual(contextForAttachedWorkspaceMismatch(ctx, failure), {
    ...ctx,
    workspaceId: '51803cee-f153-4ac1-9cd4-eab97fd4aa3a',
  });
  assert.equal(contextForAttachedWorkspaceMismatch(ctx, { fallback: { error: 'other' } }), null);
});

test('computer help surfaces the recruiting shortcut without auth', async () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };
    const help = await runCliAsync(['computer', '--help'], { cwd, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /recruiting\s+Open the Atris Labs recruiting computer/);
    assert.match(help.stdout, /atris computer recruiting status/);
    assert.match(help.stdout, /atris computer recruiting sync/);
    assert.match(help.stdout, /atris computer recruiting pull/);
    assert.match(help.stdout, /atris computer recruiting push --dry-run/);

    const shortcutHelp = await runCliAsync(['computer', 'recruiting', 'help'], { cwd, env });
    assert.equal(shortcutHelp.status, 0, shortcutHelp.stderr || shortcutHelp.stdout);
    assert.match(shortcutHelp.stdout, /Usage: atris computer recruiting/);
    assert.match(shortcutHelp.stdout, /sync/);
    assert.match(shortcutHelp.stdout, /pull/);
    assert.match(shortcutHelp.stdout, /push --dry-run/);

    const syncHelp = await runCliAsync(['computer', 'recruiting', 'sync', '--help'], { cwd, env });
    assert.equal(syncHelp.status, 0, syncHelp.stderr || syncHelp.stdout);
    assert.match(syncHelp.stdout, /Usage: atris computer recruiting sync/);
    assert.match(syncHelp.stdout, /atris sync --watch/);

    const pullHelp = await runCliAsync(['computer', 'recruiting', 'pull', '--help'], { cwd, env });
    assert.equal(pullHelp.status, 0, pullHelp.stderr || pullHelp.stdout);
    assert.match(pullHelp.stdout, /Usage: atris computer recruiting pull/);
    assert.match(pullHelp.stdout, /atris pull atris-labs --keep-local --fail-on-conflict/);

    const pushHelp = await runCliAsync(['computer', 'recruiting', 'push', '--help'], { cwd, env });
    assert.equal(pushHelp.status, 0, pushHelp.stderr || pushHelp.stdout);
    assert.match(pushHelp.stdout, /Usage: atris computer recruiting push/);
    assert.match(pushHelp.stdout, /atris push atris-labs --dry-run/);

    const watchHelp = await runCliAsync(['computer', 'recruiting', 'watch', '--help'], { cwd, env });
    assert.equal(watchHelp.status, 0, watchHelp.stderr || watchHelp.stdout);
    assert.match(watchHelp.stdout, /Usage: atris computer recruiting watch/);
    assert.match(watchHelp.stdout, /atris sync --watch/);
  } finally {
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting sync prints local sync commands outside a business workspace', async () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };
    const res = await runCliAsync(['computer', 'recruiting', 'sync'], { cwd, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Recruiting local sync/);
    assert.match(res.stdout, /local workspace: not detected/);
    assert.match(res.stdout, /cd ~\/arena\/atris-business\/atris-labs/);
    assert.match(res.stdout, /atris sync --dry-run/);
    assert.match(res.stdout, /atris sync --watch/);
  } finally {
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting pull and push explain canonical commands without auth', async () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };
    const pull = await runCliAsync(['computer', 'recruiting', 'pull'], { cwd, env });
    assert.equal(pull.status, 0, pull.stderr || pull.stdout);
    assert.match(pull.stdout, /Recruiting local pull/);
    assert.match(pull.stdout, /local workspace: not detected/);
    assert.match(pull.stdout, /atris pull atris-labs --keep-local --fail-on-conflict/);
    assert.match(pull.stdout, /cd ~\/arena\/atris-business\/atris-labs/);

    const push = await runCliAsync(['computer', 'recruiting', 'push'], { cwd, env });
    assert.equal(push.status, 0, push.stderr || push.stdout);
    assert.match(push.stdout, /Recruiting local push/);
    assert.match(push.stdout, /local workspace: not detected/);
    assert.match(push.stdout, /atris push atris-labs --dry-run/);
    assert.match(push.stdout, /atris computer recruiting push --dry-run/);
  } finally {
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting sync auto-detects the canonical business workspace without auth', async () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  const recruitingRoot = path.join(home, 'arena', 'atris-business', 'atris-labs');
  try {
    fs.mkdirSync(path.join(recruitingRoot, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(recruitingRoot, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(recruitingRoot, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-recruiting',
      workspace_id: 'ws-recruiting',
      slug: 'atris-labs',
      name: 'Atris Labs',
    }), 'utf8');
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };
    const res = await runCliAsync(['computer', 'recruiting', 'sync'], { cwd, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Recruiting local sync/);
    assert.match(res.stdout, /folder: ~\/arena\/atris-business\/atris-labs \(auto-detected\)/);
    assert.match(res.stdout, /Business workspace sync status/);
    assert.match(res.stdout, /business: atris-labs/);
    assert.match(res.stdout, /atris sync --dry-run/);
    assert.match(res.stdout, /atris sync --watch/);
  } finally {
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting sync ignores non-recruiting current business bindings', async () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  const recruitingRoot = path.join(home, 'arena', 'atris-business', 'atris-labs');
  try {
    fs.mkdirSync(path.join(cwd, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-other',
      workspace_id: 'ws-other',
      slug: 'other-co',
      name: 'Other Co',
    }), 'utf8');

    fs.mkdirSync(path.join(recruitingRoot, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(recruitingRoot, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(recruitingRoot, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-recruiting',
      workspace_id: 'ws-recruiting',
      slug: 'atris-labs',
      name: 'Atris Labs',
    }), 'utf8');

    const env = {
      ...process.env,
      HOME: home,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };
    const res = await runCliAsync(['computer', 'recruiting', 'sync'], { cwd, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /folder: ~\/arena\/atris-business\/atris-labs \(auto-detected\)/);
    assert.match(res.stdout, /business: atris-labs/);
    assert.doesNotMatch(res.stdout, /business: other-co/);
  } finally {
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting sync shows local business sync status without auth', async () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    fs.mkdirSync(path.join(cwd, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-recruiting',
      workspace_id: 'ws-recruiting',
      slug: 'atris-labs',
      name: 'Atris Labs',
    }), 'utf8');
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };
    const res = await runCliAsync(['computer', 'recruiting', 'sync'], { cwd, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Recruiting local sync/);
    assert.match(res.stdout, /Business workspace sync status/);
    assert.match(res.stdout, /business: atris-labs/);
    assert.match(res.stdout, /atris sync --status/);
    assert.match(res.stdout, /atris sync --watch/);
  } finally {
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('top-level wake and sleep use business computer lifecycle for business slugs', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const wake = await runCliAsync(['wake', 'atris-labs'], { cwd, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    assert.match(wake.stdout, /Business computer 'Atris Labs' is alive/);

    const sleep = await runCliAsync(['sleep', 'atris-labs'], { cwd, env });
    assert.equal(sleep.status, 0, sleep.stderr || sleep.stdout);
    assert.match(sleep.stdout, /Business computer 'Atris Labs' is now sleeping/);

    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ['GET', '/api/business/'],
        ['POST', '/api/business/biz-1/workspaces/ws-old/activate'],
        ['POST', '/api/business/biz-1/ai-computer/wake'],
        ['GET', '/api/business/'],
        ['POST', '/api/business/biz-1/ai-computer/sleep'],
      ]
    );
    assert.ok(!requests.some((request) => request.url.includes('/api/workspace/')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

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
    assert.match(res.stdout, /Start here:/);
    assert.match(res.stdout, /atris computer --business atris-labs --workspace ws-new/);
    assert.match(res.stdout, /Org workspace:/);
    assert.match(res.stdout, /cd ~\/arena\/atris-business\/atris-labs/);
    assert.match(res.stdout, /atris member activate operator/);
    assert.match(res.stdout, /atris member activate validator/);
    assert.match(res.stdout, /Runtime: install=installed_latest/);
    assert.match(res.stdout, /receipt=.atris\/state\/runtime\.json/);
    const bootstrapRequest = requests.find((request) => (
      request.method === 'POST' &&
      request.url === '/api/business/biz-1/workspaces/ws-new/terminal' &&
      String(request.body?.command || '').includes('atris-runtime-bootstrap-npm.log')
    ));
    assert.ok(bootstrapRequest, 'expected runtime bootstrap terminal command');
    assert.match(bootstrapRequest.body.command, /npm install --prefix "\$LOCAL_NPM_PREFIX" atris@latest/);
    assert.match(bootstrapRequest.body.command, /\$LOCAL_ATRIS_BIN" update/);
    assert.doesNotMatch(bootstrapRequest.body.command, /npm install -g atris@latest/);
    assert.match(res.stdout, /Default:\s+unchanged \(ws-old\)/);
    assert.match(res.stdout, /Switch default: atris computer activate --business atris-labs --workspace ws-new/);
    assert.match(res.stdout, /If the org workspace does not exist yet:/);
    assert.match(res.stdout, /atris business init "Atris Labs"/);
    assert.doesNotMatch(res.stdout, /atris member create operator/);
    assert.match(res.stdout, /Cost control:/);
    assert.match(res.stdout, /atris computer sleep --business atris-labs --workspace ws-new/);

    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ['GET', '/api/business/'],
        ['POST', '/api/business/biz-1/workspaces'],
        ['POST', '/api/business/biz-1/workspaces/ws-new/activate'],
        ['POST', '/api/business/biz-1/ai-computer/wake'],
        ['POST', '/api/business/biz-1/workspaces/ws-new/terminal'],
      ]
    );
    assert.deepEqual(requests[1].body, { name: 'My Business Computer', type: 'general' });
    assert.ok(requests.every((request) => request.authorization === 'Bearer test-token'));

    const cachePath = path.join(home, '.atris', 'businesses.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache['atris-labs'].workspace_id, 'ws-old');

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
    assert.equal(requests.length, 6);
    assert.deepEqual(requests.at(-1), {
      method: 'GET',
      url: '/api/business/biz-1/workspaces/ws-old/files?path=.',
      authorization: 'Bearer test-token',
      body: null,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer create --set-default updates the cached workspace', async () => {
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
      '--set-default',
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
    assert.match(res.stdout, /Default:\s+now ws-new/);
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'businesses.json'), 'utf8'));
    assert.equal(cache['atris-labs'].workspace_id, 'ws-new');
    assert.equal(cache['atris-labs'].computer_name, 'My Business Computer');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting create seeds a typed recruiting workspace', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'recruiting',
      'create',
      '--set-default',
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
    assert.match(res.stdout, /Name:\s+Recruiting Computer/);
    assert.match(res.stdout, /Type:\s+recruiting/);
    assert.match(res.stdout, /Default:\s+now ws-new/);
    const createRequest = requests.find((request) => request.method === 'POST' && request.url === '/api/business/biz-1/workspaces');
    assert.deepEqual(createRequest.body, { name: 'Recruiting Computer', type: 'recruiting' });
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'businesses.json'), 'utf8'));
    assert.equal(cache['atris-labs'].workspace_id, 'ws-new');
    assert.equal(cache['atris-labs'].computer_type, 'recruiting');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting status targets the recruiting workspace', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'recruiting',
      'status',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Business:\s+Atris Labs/);
    assert.match(res.stdout, /Target workspace:\s+Recruiting Computer \(ws-recruiting\)/);
    assert.match(res.stdout, /Health:\s+ready/);
    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/api/business/biz-1/workspaces/ws-recruiting/terminal'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer recruiting run routes shell commands to the recruiting workspace', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'recruiting',
      'run',
      'echo RECRUITING_OK',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.ok(requests.some((request) => (
      request.method === 'POST' &&
      request.url === '/api/business/biz-1/workspaces/ws-recruiting/terminal' &&
      request.body?.command === 'echo RECRUITING_OK'
    )));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer activate attaches workspace and updates the cached default', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const res = await runCliAsync([
      'computer',
      'activate',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
    ], { cwd, env });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Activated workspace ws-new/);
    assert.match(res.stdout, /CLI default: ws-new/);
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'businesses.json'), 'utf8'));
    assert.equal(cache['atris-labs'].workspace_id, 'ws-new');
    const activateRequest = requests.find((request) => request.method === 'POST' && request.url === '/api/business/biz-1/workspaces/ws-new/activate');
    assert.ok(activateRequest);
    assert.equal(activateRequest.body.force, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer activate --force sends explicit takeover flag', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const res = await runCliAsync([
      'computer',
      'activate',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
      '--force',
    ], { cwd, env });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    const activateRequest = requests.find((request) => request.method === 'POST' && request.url === '/api/business/biz-1/workspaces/ws-new/activate');
    assert.ok(activateRequest);
    assert.equal(activateRequest.body.force, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer run prints workspace mismatch detail instead of saying off', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'run',
      'echo hello',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-mismatch',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stderr, /AI computer is attached to workspace ws-old/);
    assert.match(res.stderr, /atris computer activate --business atris-labs --workspace ws-mismatch/);
    assert.doesNotMatch(res.stderr, /Computer is off/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer status shows default target and attached workspace truth', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'status',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Default workspace:\s+Main \(ws-old\)/);
    assert.match(res.stdout, /Target workspace:\s+My Business Computer \(ws-new\)/);
    assert.match(res.stdout, /Attached workspace:\s+My Business Computer \(ws-new\)/);
    assert.match(res.stdout, /Attached by:\s+operator-1/);
    assert.match(res.stdout, /Attached at:\s+2026-05-19T09:00:00\+00:00/);
    assert.match(res.stdout, /Lease age:\s+2m/);
    assert.match(res.stdout, /Takeover hint:\s+Use --force to take over Main\./);
    assert.match(res.stdout, /Health:\s+ready/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer status resolves workspace name before probing health', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'status',
      '--business',
      'atris-labs',
      '--workspace',
      'My Business Computer',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Target workspace:\s+My Business Computer \(ws-new\)/);
    assert.match(res.stdout, /Health:\s+ready/);
    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/api/business/biz-1/workspaces/ws-new/terminal'));
    assert.ok(!requests.some((request) => request.url.includes('My%20Business%20Computer')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer action commands resolve workspace name before backend calls', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const run = await runCliAsync([
      'computer',
      'run',
      'echo ACTION_ALIAS_OK',
      '--business',
      'atris-labs',
      '--workspace',
      'Main',
    ], { cwd, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const exec = await runCliAsync([
      'computer',
      'exec',
      '--no-wait',
      '--business',
      'atris-labs',
      '--workspace',
      'Main',
      'Reply briefly',
    ], { cwd, env });
    assert.equal(exec.status, 0, exec.stderr || exec.stdout);
    assert.match(exec.stdout, /workspace_id=ws-old/);

    const cat = await runCliAsync([
      'computer',
      'cat',
      'README.md',
      '--business',
      'atris-labs',
      '--workspace',
      'Main',
    ], { cwd, env });
    assert.equal(cat.status, 0, cat.stderr || cat.stdout);
    assert.match(cat.stdout, /# Atris/);

    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/api/business/biz-1/workspaces/ws-old/terminal'));
    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/api/business/biz-1/chat' && request.body?.workspace_id === 'ws-old'));
    assert.ok(requests.some((request) => request.method === 'GET' && request.url === '/api/business/biz-1/workspaces/ws-old/file?path=README.md'));
    assert.ok(!requests.some((request) => request.url.includes('/workspaces/Main/')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer exec waits and streams the business chat result by default', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const res = await runCliAsync([
      'computer',
      'exec',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
      'What is 2+2?',
    ], { cwd, env });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Lane: Claude/);
    assert.match(res.stdout, /Execution: exec-1/);
    assert.match(res.stdout, /Running on cloud/);
    assert.match(res.stdout, /4/);
    assert.doesNotMatch(res.stdout, /Use the stream URL/);
    assert.ok(requests.some((request) => request.url.startsWith('/api/business/biz-1/chat/events?')));
    assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/api/business/biz-1/chat' && request.body?.worker === 'claude'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer exec replays buffered result when completed poll delta is empty', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const res = await runCliAsync([
      'computer',
      'exec',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
      'EMPTY_DELTA_REFETCH',
    ], { cwd, env });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /RECOVERED_RESULT/);
    assert.doesNotMatch(res.stdout, /\(no result\)/);
    const eventPolls = requests.filter((request) => request.url.startsWith('/api/business/biz-1/chat/events?'));
    assert.equal(eventPolls.length, 2);
    assert.ok(eventPolls.every((request) => request.url.includes('from_index=0')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer exec --no-wait keeps async stream URL mode', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const res = await runCliAsync([
      'computer',
      'exec',
      '--no-wait',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
      'What is 2+2?',
    ], { cwd, env });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Use the stream URL/);
    assert.ok(!requests.some((request) => request.url.startsWith('/api/business/biz-1/chat/events?')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer chat sends piped prompts non-interactively', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const res = await runCliAsync([
      'computer',
      'chat',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
    ], {
      cwd,
      env,
      input: 'What is 2+2?\n/exit\n',
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris Cloud Computer/);
    assert.match(res.stdout, /Running on cloud/);
    assert.match(res.stdout, /4/);
    assert.ok(requests.some((request) => (
      request.method === 'POST' &&
      request.url === '/api/business/biz-1/chat' &&
      request.body?.message === 'What is 2+2?' &&
      request.body?.worker === 'claude'
    )));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer chat --message sends one quiet non-interactive prompt', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };

    const res = await runCliAsync([
      'computer',
      'chat',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
      '--worker',
      'claude',
      '--message',
      'Reply exactly CHAT_OK',
    ], { cwd, env });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), 'CHAT_OK');
    assert.doesNotMatch(res.stdout, /Atris Cloud Computer/);
    assert.doesNotMatch(res.stdout, /Running on cloud/);
    assert.ok(requests.some((request) => (
      request.method === 'POST' &&
      request.url === '/api/business/biz-1/chat' &&
      request.body?.message === 'Reply exactly CHAT_OK' &&
      request.body?.worker === 'claude'
    )));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('business init seeds Atris operator onboarding as the first computer path', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'business',
      'init',
      'Acme Corp',
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
    assert.match(res.stdout, /Business created!/);
    assert.match(res.stdout, /Atris:\s+seeded local computer \+ operator \+ validator/);
    assert.match(res.stdout, /Start here:/);
    assert.match(res.stdout, /atris member activate operator/);
    assert.match(res.stdout, /atris business onboard --website <url> --contact "Name" --note "what they do"/);
    assert.match(res.stdout, /Sync when ready:/);
    assert.match(res.stdout, /atris sync --dry-run/);
    assert.match(res.stdout, /atris sync/);

    const workspaceRoot = path.join(home, 'arena', 'atris-business', 'acme-corp');
    assert.ok(fs.existsSync(path.join(workspaceRoot, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(workspaceRoot, 'atris', 'team', 'operator', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(workspaceRoot, 'atris', 'team', 'validator', 'MEMBER.md')));

    const runtime = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.atris', 'state', 'runtime.json'), 'utf8'));
    assert.equal(runtime.schema, 'atris.runtime.v1');
    assert.equal(runtime.scope, 'local-business-computer');
    assert.equal(runtime.install_status, 'local_cli_present');
    assert.equal(runtime.sync_status, 'templates_seeded');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer delete refuses noninteractive delete without confirmation', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'delete',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /Confirmation required/);
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [['GET', '/api/business/']]
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer up and sleep are simple lifecycle commands', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const env = {
      ...process.env,
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    };
    const up = await runCliAsync([
      'computer',
      'up',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
    ], { cwd, env });
    const sleep = await runCliAsync([
      'computer',
      'sleep',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
    ], { cwd, env });

    assert.equal(up.status, 0, up.stderr || up.stdout);
    assert.match(up.stdout, /Computer is awake/);
    assert.match(up.stdout, /Runtime: install=installed_latest/);
    assert.equal(sleep.status, 0, sleep.stderr || sleep.stdout);
    assert.match(sleep.stdout, /No compute cost while sleeping/);
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ['GET', '/api/business/'],
        ['POST', '/api/business/biz-1/ai-computer/wake'],
        ['POST', '/api/business/biz-1/workspaces/ws-new/terminal'],
        ['POST', '/api/business/biz-1/ai-computer/sleep'],
      ]
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});

test('computer delete sleeps before deleting confirmed workspace', async () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  const requests = [];
  const server = await startApiServer(requests);
  try {
    writeCredentials(home);
    const { port } = server.address();
    const res = await runCliAsync([
      'computer',
      'delete',
      '--business',
      'atris-labs',
      '--workspace',
      'ws-new',
      '--confirm',
      'delete ws-new',
    ], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
        ATRIS_NO_INTERACTIVE: '1',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Computer is sleeping/);
    assert.match(res.stdout, /Computer deleted/);
    assert.match(res.stdout, /Cost gate/);
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ['GET', '/api/business/'],
        ['POST', '/api/business/biz-1/ai-computer/sleep'],
        ['DELETE', '/api/business/biz-1/workspaces/ws-new'],
      ]
    );
    assert.ok(requests.every((request) => request.authorization === 'Bearer test-token'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupTempDir(home);
    cleanupTempDir(cwd);
  }
});
