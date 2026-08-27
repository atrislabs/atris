const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

function writeCliState(home) {
  const atrisDir = path.join(home, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'credentials.json'), JSON.stringify({ token: 'test-token' }));
  fs.writeFileSync(path.join(atrisDir, 'businesses.json'), JSON.stringify({
    acme: {
      business_id: 'biz-1',
      workspace_id: 'ws-1',
      name: 'Acme Co',
      slug: 'acme',
    },
  }));
}

function startApi(requests) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (body.path === '/bad.txt') {
        res.statusCode = 422;
        res.end(JSON.stringify({ detail: 'workspace is read only' }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('business deploy reports failed workspace uploads and exits nonzero after the dashboard', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-deploy-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-deploy-cwd-'));
  const workspace = path.join(cwd, 'atris', 'business', 'acme', 'workspace');
  const requests = [];
  const server = await startApi(requests);
  writeCliState(home);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'bad.txt'), 'bad');
  fs.writeFileSync(path.join(workspace, 'good.txt'), 'good');
  fs.writeFileSync(path.join(cwd, 'atris', 'business', 'acme', 'BUSINESS.md'), '# Acme');

  try {
    const res = await runCli(['business', 'deploy', 'acme', '--account'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 1, res.stderr || res.stdout);
    assert.match(res.stdout, /  Failed: bad\.txt \(workspace is read only\)/);
    assert.match(res.stdout, /  Uploaded: good\.txt/);
    assert.match(res.stdout, /  Dashboard: https:\/\/atris\.ai\/dashboard\/gm\/biz-1/);
    assert.match(res.stdout, /  1 of 2 files failed to upload/);
    assert.equal(requests.length, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
