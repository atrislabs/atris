'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { findWorkspaceBusinessId } = require('../commands/member');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-business-'));
}

function writeMember(root, name = 'sales') {
  const memberDir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Sales',
    '---',
    '',
    '# Sales',
    '',
  ].join('\n'));
}

function runMemberPush(root, apiUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'member', 'push', 'sales'], {
      cwd: root,
      env: {
        ...process.env,
        ATRIS_API_URL: apiUrl,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_TOKEN: 'test-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, apiUrl: `http://127.0.0.1:${server.address().port}/api` });
    });
  });
}

test('findWorkspaceBusinessId walks up to the nearest business binding', () => {
  const root = makeWorkspace();
  try {
    const nested = path.join(root, 'atris', 'team', 'sales');
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(root, '.atris', 'business.json'),
      JSON.stringify({ business_id: 'business-123', slug: 'test-business' }),
    );

    assert.equal(findWorkspaceBusinessId(nested), 'business-123');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findWorkspaceBusinessId returns null when no binding exists', () => {
  const root = makeWorkspace();
  try {
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    assert.equal(findWorkspaceBusinessId(nested), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findWorkspaceBusinessId warns once and returns null for malformed JSON', () => {
  const root = makeWorkspace();
  const originalWarn = console.warn;
  const warnings = [];
  try {
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), '{not json');
    console.warn = (...args) => warnings.push(args.join(' '));

    assert.equal(findWorkspaceBusinessId(root), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\.atris[/\\]business\.json/);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member push binds the imported agent to the workspace business', async () => {
  const root = makeWorkspace();
  const requests = [];
  const { server, apiUrl } = await startServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agent_id: 'agent-123' }));
  });
  try {
    writeMember(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(
      path.join(root, '.atris', 'business.json'),
      JSON.stringify({ business_id: 'biz id/123', slug: 'test-business' }),
    );

    const result = await runMemberPush(root, apiUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests, ['/api/agent/import-member?business_id=biz%20id%2F123']);
    assert.match(result.stdout, /Bound to business biz id\/123/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member push keeps the existing endpoint when no business binding exists', async () => {
  const root = makeWorkspace();
  const requests = [];
  const { server, apiUrl } = await startServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agent_id: 'agent-123' }));
  });
  try {
    writeMember(root);

    const result = await runMemberPush(root, apiUrl);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests, ['/api/agent/import-member']);
    assert.doesNotMatch(result.stdout, /Bound to business/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member push surfaces a backend access error', async () => {
  const root = makeWorkspace();
  const { server, apiUrl } = await startServer((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'You do not have access to this business' }));
  });
  try {
    writeMember(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(
      path.join(root, '.atris', 'business.json'),
      JSON.stringify({ business_id: 'business-123' }),
    );

    const result = await runMemberPush(root, apiUrl);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Push failed: You do not have access to this business/);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
