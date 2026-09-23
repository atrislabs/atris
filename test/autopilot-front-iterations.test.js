'use strict';

// The improve fallback (and older automation) spawns
// `atris autopilot --auto --iterations=1` and means exactly one leg.
// The front loop must honor that cap instead of running unbounded.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { maxLegsFlag } = require('../commands/autopilot-front');

test('maxLegsFlag parses --iterations=N and --iterations N', () => {
  assert.equal(maxLegsFlag(['--auto', '--iterations=1']), 1);
  assert.equal(maxLegsFlag(['--iterations', '3']), 3);
  assert.equal(maxLegsFlag(['--auto']), null);
  assert.equal(maxLegsFlag(['--iterations=0']), null);
  assert.equal(maxLegsFlag(['--iterations=junk']), null);
});

test('autopilot member leg drives unchecked work', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autopilot-member-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memberDir = path.join(root, 'atris', 'team', 'demo');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '---\nname: demo\n---\n');
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/atris2/turn') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"result","result":"finished bounded work"}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const child = spawn(process.execPath, [cli, 'autopilot', '--yes', '--once', '--leg-wall', '60'], {
    cwd: root,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TOKEN: 'test-token',
      ATRIS_API_URL: `http://127.0.0.1:${port}/api` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timeout);
  assert.equal(status, 0, output);
  assert.match(output, /member demo chooses useful work/);
  assert.match(output, /\[mission run\]/);
  assert.doesNotMatch(output, /created, not started/);
  const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.mission?.last_tick_status === 'ran' || row.last_tick_status === 'ran'));
});
