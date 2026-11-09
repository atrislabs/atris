'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function runChat(t, reply, interactive = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chat-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const token = `test.${Buffer.from(JSON.stringify({ type: 'agent_access', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_AGENT_TOKEN_FILE: path.join(dir, 'token.json'), ATRIS_TOKEN: token, ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`, NO_COLOR: '1' };
  const args = [path.resolve(__dirname, '../bin/atris.js'), 'chat', '--personal', ...(interactive ? [] : ['hello'])];
  const child = spawn(process.execPath, args, { cwd: dir, env, stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', sentBye = false;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (interactive && !sentBye && stdout.includes('confirm whether it finished')) {
      sentBye = true;
      setTimeout(() => child.stdin.end('bye\n'), 50);
    }
  });
  if (interactive) child.stdin.write('hello\n');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { clearTimeout(timer); }
  return { code, stdout, stderr, requests };
}

test('one-shot personal chat prints uncertainty and reports failure', async t => {
  const result = await runChat(t, { success: false, intent: 'message_received', response: "I received this request, but I can't confirm whether it finished. Check the result before starting it again.", agent_id: 'agent-1' });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /can't confirm whether it finished/);
  assert.deepEqual(result.requests, [{ path: '/api/message/incoming', body: { message: 'hello', source: 'cli' } }]);
});

test('one-shot personal chat retains success and legacy response handling', async t => {
  for (const reply of [{ success: true, response: 'All done.' }, { response: 'Older reply.' }]) {
    const result = await runChat(t, reply);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(reply.response.replace('.', '\\.')));
    assert.equal(result.requests.length, 1);
  }
});


test('interactive personal chat shows uncertainty without retrying it', async t => {
  const result = await runChat(t, { success: false, intent: 'message_received', response: "I received this request, but I can't confirm whether it finished. Check the result before starting it again.", agent_id: 'agent-1' }, true);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /can't confirm whether it finished/);
  assert.equal(result.requests.length, 1);
});
