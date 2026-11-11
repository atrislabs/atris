'use strict';

// The real `atris chat --personal` binary against a local fake server: a
// started job is waited on and its answer printed, one-shot and interactive.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const JOB = 'bff7c9d5-8953-5b5f-9660-faa388d99005';
const ANSWER = 'Wed Nov 11 13:29:02 UTC 2026';

function fakeServer(pollsBeforeDone) {
  const seen = { posts: [], gets: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/message/incoming') {
        seen.posts.push(JSON.parse(raw));
        res.end(JSON.stringify({
          success: true,
          intent: 'mission_start',
          response: "I understood: run date. I'm starting now.",
          card: { mission_id: JOB, state: 'ready', needs: null },
        }));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith(`/api/atris2/missions/${JOB}`)) {
        seen.gets += 1;
        res.end(JSON.stringify(seen.gets > pollsBeforeDone
          ? { task_id: JOB, status: 'completed', state: 'done', result: { response: ANSWER } }
          : { task_id: JOB, status: 'in_progress', state: 'working', working_on: 'Working through your request' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/api` }));
  });
}

function runCli(args, url, input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-job-cli-'));
  const token = `test.${Buffer.from(JSON.stringify({
    type: 'agent_access',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url')}.test`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: {
        ...scrubAgentEnv(),
        HOME: home,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_AGENT_TOKEN_FILE: path.join(home, 'agent-token.json'),
        ATRIS_API_URL: url,
        ATRIS_TOKEN: token,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out\n${stdout}\n${stderr}`)); }, 20000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

test('atris chat --personal prints the finished job answer, not the starting line', async () => {
  const { server, seen, url } = await fakeServer(0);
  try {
    const r = await runCli(['chat', '--personal', 'run date on my computer'], url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), ANSWER);
    assert.doesNotMatch(r.stdout, /starting now/);
    assert.equal(seen.posts.length, 1, 'one message sent, one job started');
    assert.deepEqual(seen.posts[0], { message: 'run date on my computer', source: 'cli' });
    assert.equal(seen.gets, 1);
  } finally {
    server.close();
  }
});

test('atris chat --personal keeps waiting while the job works', async () => {
  const { server, seen, url } = await fakeServer(1);
  try {
    const r = await runCli(['chat', '--personal', 'run date on my computer'], url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), ANSWER);
    assert.equal(seen.gets, 2);
  } finally {
    server.close();
  }
});

test('interactive chat waits for a started job and prints its answer', async () => {
  const { server, seen, url } = await fakeServer(0);
  try {
    const r = await runCli(['chat', '--personal'], url, 'run date on my computer\nbye\n');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`atris › ${ANSWER}`));
    assert.doesNotMatch(r.stdout, /starting now/);
    assert.equal(seen.posts.length, 1);
  } finally {
    server.close();
  }
});
