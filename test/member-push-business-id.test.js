const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const memberContent = [
  '---',
  'name: navigator',
  'role: Finds the next useful route',
  '---',
  '',
  '# Navigator',
  '',
].join('\n');

function makeWorkspace({ businessId } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-push-'));
  const memberDir = path.join(root, 'atris', 'team', 'navigator');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), memberContent, 'utf8');
  if (businessId) {
    const bindingDir = path.join(root, '.atris');
    fs.mkdirSync(bindingDir, { recursive: true });
    fs.writeFileSync(
      path.join(bindingDir, 'business.json'),
      JSON.stringify({ business_id: businessId }),
      'utf8'
    );
  }
  return root;
}

function startImportServer(requests) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agent_id: 'agent-navigator' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function runCli(args, { cwd, env }) {
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

function cliEnv(port, home) {
  return {
    ...process.env,
    HOME: home,
    ATRIS_TOKEN: 'test-token',
    ATRIS_API_URL: `http://127.0.0.1:${port}/api`,
    ATRIS_SKIP_UPDATE_CHECK: '1',
  };
}

test('member push includes the workspace business_id as a form field', async () => {
  const root = makeWorkspace({ businessId: 'biz-roster' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-push-home-'));
  const requests = [];
  const server = await startImportServer(requests);
  const port = server.address().port;

  try {
    const result = await runCli(['member', 'push', 'navigator'], {
      cwd: root,
      env: cliEnv(port, home),
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/agent/import-member');
    assert.equal(requests[0].contentType, 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(requests[0].body);
    assert.equal(form.get('content'), memberContent);
    assert.equal(form.get('business_id'), 'biz-roster');
    assert.doesNotMatch(result.stdout, /no business binding found/);
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('member push omits business_id and prints a binding hint when unbound', async () => {
  const root = makeWorkspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-push-home-'));
  const requests = [];
  const server = await startImportServer(requests);
  const port = server.address().port;

  try {
    const result = await runCli(['member', 'push', 'navigator'], {
      cwd: root,
      env: cliEnv(port, home),
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    const form = new URLSearchParams(requests[0].body);
    assert.equal(form.get('content'), memberContent);
    assert.equal(form.has('business_id'), false);
    assert.match(
      result.stdout,
      /no business binding found; run `atris business init "<name>" --here` to bind this workspace\./
    );
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
