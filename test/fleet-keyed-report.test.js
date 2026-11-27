const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('Fleet sends a keyed completion only to the retry-safe receiver and propagates refusal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes = [];
  let status = 201;
  let identityStatus = 200;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST') writes.push({ path: req.url, body: JSON.parse(body) });
    const code = req.url.endsWith('/members') ? identityStatus : (req.method === 'GET' ? 200 : status);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status < 300 ? { post_id: 'receipt-1' } : { detail: 'unavailable' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const hubUrl = 'http://127.0.0.1:' + server.address().port;
  fs.mkdirSync(path.join(root, '.swarlo'));
  fs.writeFileSync(path.join(root, '.swarlo', 'fleet-state.json'), JSON.stringify({
    hub_id: 'fixture', hub_url: hubUrl, member_id: 'reviewer', api_key: 'fixture',
  }));
  const cli = path.resolve(__dirname, '../bin/atris.js');
  async function done(...flags) {
    const child = spawn(process.execPath, [cli, 'fleet', 'done', 'repair-a', 'checked', '--global', ...flags], {
      cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, SWARLO_SERVER: hubUrl, SWARLO_HUB: 'fixture' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
  }
  const first = await done('--idempotency-key', 'first-handoff', '--json');
  assert.equal(first.code, 0);
  assert.deepEqual(writes, [{
    path: '/api/fixture/channels/general/report/once',
    body: { task_key: 'repair-a', status: 'done', content: 'checked', idempotency_key: 'first-handoff' },
  }]);
  assert.equal(JSON.parse(first.output).post_id, 'receipt-1');
  status = 404;
  assert.notEqual((await done('--idempotency-key=first-handoff')).code, 0);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.notEqual((await done('--idempotency-key')).code, 0);
  identityStatus = 403;
  assert.notEqual((await done('--idempotency-key', 'first-handoff')).code, 0);
  assert.equal(writes.length, 2);
});
