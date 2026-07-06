'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  appendRecord,
  readRecords,
  readManifest,
  writeManifest,
  defaultManifest,
  deepEqual,
  runBacktest,
  promoteProcess,
  executeBuild,
  buildCompilePrompt,
  parseValueArg,
  parseFlags,
  listProcesses,
  runnerPath,
  DEFAULT_THRESHOLD,
} = require('../commands/compile');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-compile-'));
}

function writeRunner(root, name, body) {
  const p = runnerPath(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

const DOUBLER = 'module.exports = { run: (input) => ({ doubled: input.n * 2 }) };\n';
const COMPILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'compile.js'), 'utf8');
const ATRIS_BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function seedRecords(root, name, count, { badFrom = Infinity } = {}) {
  for (let i = 0; i < count; i++) {
    const expected = i >= badFrom ? { doubled: -1 } : { doubled: i * 2 };
    appendRecord(root, name, { input: { n: i }, output: expected });
  }
}

function readPushCursorState(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'processes', name, 'push-cursor.json'), 'utf8'));
}

function cliEnv(overrides = {}) {
  const env = {
    ...process.env,
    HOME: makeRoot(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NO_UPDATE_NOTIFIER: '1',
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'ATRIS_TOKEN')) delete env.ATRIS_TOKEN;
  if (!Object.prototype.hasOwnProperty.call(overrides, 'ATRIS_PROFILE')) delete env.ATRIS_PROFILE;
  return env;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [ATRIS_BIN, ...args], {
    cwd: options.cwd || makeRoot(),
    env: options.env || cliEnv(),
    encoding: 'utf8',
  });
}

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ATRIS_BIN, ...args], {
      cwd: options.cwd || makeRoot(),
      env: options.env || cliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out: atris ${args.join(' ')}`));
    }, options.timeoutMs || 10000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

function startHttpMock(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    const request = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    };
    requests.push(request);

    const response = await handler(request, requests);
    res.statusCode = response?.status || 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response?.body || {}));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('deepEqual: primitives, objects, arrays, NaN, null', () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual('a', 'a'), true);
  assert.equal(deepEqual(NaN, NaN), true);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(null, {}), false);
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual([1, 2], { 0: 1, 1: 2 }), false);
});

test('parseValueArg: inline json, plain string, @file', () => {
  assert.deepEqual(parseValueArg('{"a":1}'), { a: 1 });
  assert.equal(parseValueArg('hello world'), 'hello world');
  assert.equal(parseValueArg('42'), 42);
  const root = makeRoot();
  const f = path.join(root, 'payload.json');
  fs.writeFileSync(f, '{"from":"file"}');
  assert.deepEqual(parseValueArg(`@${f}`), { from: 'file' });
});

test('parseFlags: --k v, --k=v, boolean flags, positionals', () => {
  const { flags, positional } = parseFlags(['name', '--input', '{"n":1}', '--threshold=0.9', '--record']);
  assert.deepEqual(positional, ['name']);
  assert.equal(flags.input, '{"n":1}');
  assert.equal(flags.threshold, '0.9');
  assert.equal(flags.record, true);
});

test('compile build uses the shared runner command instead of raw claude', () => {
  assert.doesNotMatch(COMPILE_SRC, /which claude/);
  assert.doesNotMatch(COMPILE_SRC, /claude -p "\$\(cat/);
  assert.doesNotMatch(COMPILE_SRC, /install Claude Code first/);
  assert.match(COMPILE_SRC, /buildRunnerAvailabilityCommand\(/);
  assert.match(COMPILE_SRC, /buildRunnerCommand\(/);
});

test('records: append + read round-trip with timestamps', () => {
  const root = makeRoot();
  appendRecord(root, 'demo', { input: { n: 1 }, output: { doubled: 2 } });
  appendRecord(root, 'demo', { input: { n: 2 }, output: { doubled: 4 }, expected: { doubled: 4 } });
  const records = readRecords(root, 'demo');
  assert.equal(records.length, 2);
  assert.ok(records[0].ts);
  assert.deepEqual(records[1].expected, { doubled: 4 });
  assert.deepEqual(listProcesses(root), ['demo']);
});

test('backtest: perfect runner passes the gate', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  const { result, manifest } = await runBacktest(root, 'demo');
  assert.equal(result.total, 5);
  assert.equal(result.passed, 5);
  assert.equal(result.accuracy, 1);
  assert.equal(result.threshold, DEFAULT_THRESHOLD);
  assert.deepEqual(readManifest(root, 'demo').backtest.failures, []);
  assert.equal(manifest.status, 'draft');
});

test('backtest: mismatches and thrown errors counted as failures', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 4, { badFrom: 3 }); // record 3 expects -1
  appendRecord(root, 'demo', { input: null, output: { doubled: 0 } }); // runner throws on null
  writeRunner(root, 'demo', DOUBLER);
  const { result, failureCount } = await runBacktest(root, 'demo');
  assert.equal(result.total, 5);
  assert.equal(result.passed, 3);
  assert.equal(failureCount, 2);
  assert.ok(result.failures.some((f) => f.error));
  assert.ok(result.failures.some((f) => f.actual));
});

test('backtest: expected overrides recorded output', async () => {
  const root = makeRoot();
  // recorded output was wrong; human corrected it via expected
  appendRecord(root, 'demo', { input: { n: 3 }, output: { doubled: 7 }, expected: { doubled: 6 } });
  writeRunner(root, 'demo', DOUBLER);
  const { result } = await runBacktest(root, 'demo');
  assert.equal(result.passed, 1);
});

test('backtest: missing records or runner throws clear errors', async () => {
  const root = makeRoot();
  await assert.rejects(() => runBacktest(root, 'ghost'), /no execution records/);
  seedRecords(root, 'demo', 1);
  await assert.rejects(() => runBacktest(root, 'demo'), /no compiled artifact/);
  writeRunner(root, 'demo', 'module.exports = {};\n');
  await assert.rejects(() => runBacktest(root, 'demo'), /must export \{ run\(input\) \}/);
});

test('promote: gate blocks below threshold, passes at threshold', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 10, { badFrom: 9 }); // 9/10 = 90%
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);

  await runBacktest(root, 'demo');
  assert.throws(() => promoteProcess(root, 'demo'), /below the/);

  const promoted = promoteProcess(root, 'demo', { threshold: 0.9 });
  assert.equal(promoted.status, 'active');
  assert.ok(promoted.promotedAt);
  assert.equal(readManifest(root, 'demo').threshold, 0.9);
});

test('backtest: one-off --threshold does not rewrite the standing gate', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 10, { badFrom: 9 }); // 9/10 = 90%
  writeRunner(root, 'demo', DOUBLER);
  writeManifest(root, 'demo', defaultManifest('demo'));

  const { result } = await runBacktest(root, 'demo', { threshold: 0.5 });
  assert.equal(result.threshold, 0.5); // this run was judged against the override
  assert.equal(readManifest(root, 'demo').threshold, DEFAULT_THRESHOLD); // gate untouched
  assert.throws(() => promoteProcess(root, 'demo'), /below the/); // promote still uses the gate
});

test('drift: one-off backtest threshold does not change the drift verdict', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  writeManifest(root, 'demo', defaultManifest('demo'));
  await runBacktest(root, 'demo');
  promoteProcess(root, 'demo');

  seedRecords(root, 'demo', 10, { badFrom: 5 }); // accuracy drops to 10/15
  const { manifest } = await runBacktest(root, 'demo', { threshold: 0.1 }); // lax one-off
  assert.equal(manifest.status, 'drifted'); // still judged drifted against the standing gate
});

test('promote: refuses stale backtest from an older version', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 3);
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  await runBacktest(root, 'demo');
  // simulate a recompile bumping the version after the backtest
  const bumped = readManifest(root, 'demo');
  bumped.version = 2;
  writeManifest(root, 'demo', bumped);
  assert.throws(() => promoteProcess(root, 'demo'), /re-run the backtest/);
});

test('promote: requires manifest and backtest to exist', () => {
  const root = makeRoot();
  assert.throws(() => promoteProcess(root, 'ghost'), /no manifest/);
  writeManifest(root, 'demo', defaultManifest('demo'));
  assert.throws(() => promoteProcess(root, 'demo'), /no backtest/);
});

test('drift: active process falling below gate is marked drifted', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  await runBacktest(root, 'demo');
  promoteProcess(root, 'demo');

  // the world changes: new records contradict the compiled logic
  seedRecords(root, 'demo', 10, { badFrom: 5 });
  const { manifest: after } = await runBacktest(root, 'demo');
  assert.equal(after.status, 'drifted');
});

test('rebuild: an active process drops to draft and must re-earn the gate', async () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  await runBacktest(root, 'demo');
  promoteProcess(root, 'demo');
  assert.equal(readManifest(root, 'demo').status, 'active');

  // recompile: cmdOverride seam stands in for the claude build (runner already on disk)
  const rebuilt = executeBuild(root, 'demo', { cmdOverride: 'true' });
  assert.equal(rebuilt.status, 'draft'); // active badge does not survive unverified code
  assert.equal(rebuilt.backtest, null);
  assert.equal(rebuilt.version, 2);
  assert.throws(() => promoteProcess(root, 'demo'), /no backtest/);
});

test('executeBuild honors ATRIS_CLAUDE_BIN when no cmdOverride is provided', () => {
  const root = makeRoot();
  seedRecords(root, 'demo', 5);
  const fakeRunner = path.join(root, 'fake-runner');
  fs.writeFileSync(fakeRunner, [
    '#!/bin/sh',
    'mkdir -p atris/processes/demo',
    "cat > atris/processes/demo/run.js <<'RUNNER'",
    DOUBLER.trim(),
    'RUNNER',
    '',
  ].join('\n'));
  fs.chmodSync(fakeRunner, 0o755);

  const prevRunnerBin = process.env.ATRIS_RUNNER_BIN;
  const prevRunnerProfile = process.env.ATRIS_RUNNER_PROFILE;
  const prevRunnerTemplate = process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  const prevBin = process.env.ATRIS_CLAUDE_BIN;
  const prevTemplate = process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  delete process.env.ATRIS_RUNNER_PROFILE;
  delete process.env.ATRIS_RUNNER_BIN;
  delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
  process.env.ATRIS_CLAUDE_BIN = fakeRunner;
  delete process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
  try {
    const manifest = executeBuild(root, 'demo');
    assert.equal(manifest.status, 'draft');
    assert.equal(manifest.version, 1);
    assert.ok(fs.existsSync(runnerPath(root, 'demo')));
  } finally {
    if (prevRunnerBin === undefined) delete process.env.ATRIS_RUNNER_BIN;
    else process.env.ATRIS_RUNNER_BIN = prevRunnerBin;
    if (prevRunnerProfile === undefined) delete process.env.ATRIS_RUNNER_PROFILE;
    else process.env.ATRIS_RUNNER_PROFILE = prevRunnerProfile;
    if (prevRunnerTemplate === undefined) delete process.env.ATRIS_RUNNER_COMMAND_TEMPLATE;
    else process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = prevRunnerTemplate;
    if (prevBin === undefined) delete process.env.ATRIS_CLAUDE_BIN;
    else process.env.ATRIS_CLAUDE_BIN = prevBin;
    if (prevTemplate === undefined) delete process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE;
    else process.env.ATRIS_CLAUDE_COMMAND_TEMPLATE = prevTemplate;
  }
});

test('writeManifest: leaves no partial tmp file behind', () => {
  const root = makeRoot();
  writeManifest(root, 'demo', defaultManifest('demo'));
  const dir = path.dirname(require('../commands/compile').manifestPath(root, 'demo'));
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
  assert.equal(readManifest(root, 'demo').status, 'draft');
});

test('backtest: supports async run()', async () => {
  const root = makeRoot();
  appendRecord(root, 'demo', { input: { n: 5 }, output: { doubled: 10 } });
  writeRunner(root, 'demo', 'module.exports = { run: async (input) => ({ doubled: input.n * 2 }) };\n');
  const { result } = await runBacktest(root, 'demo');
  assert.equal(result.accuracy, 1);
});

test('buildCompilePrompt: states the contract and samples records', () => {
  const root = makeRoot();
  const records = Array.from({ length: 30 }, (_, i) => ({ input: { n: i }, output: { doubled: i * 2 } }));
  const prompt = buildCompilePrompt(root, 'demo', records, 'watch the edge cases');
  assert.match(prompt, /module\.exports = \{ run \}/);
  assert.match(prompt, /deterministic/);
  assert.match(prompt, /zero npm dependencies/);
  assert.match(prompt, /do not hardcode a lookup table/);
  assert.match(prompt, /most recent 25 of 30/);
  assert.match(prompt, /watch the edge cases/);
  assert.match(prompt, /\[COMPILE_COMPLETE\]/);
  // no spec yet -> instructs the compiler to write one
  assert.match(prompt, /There is no spec file yet/);
});

test('publish pushes artifact and records with cursor dedupe', async () => {
  const root = makeRoot();
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  manifest.compiledAt = '2026-07-06T00:00:00.000Z';
  writeManifest(root, 'demo', manifest);
  appendRecord(root, 'demo', { input: { n: 1 }, output: { doubled: 2 } });
  appendRecord(root, 'demo', { input: { n: 2 }, output: { doubled: 4 }, expected: { doubled: 4 }, source: 'human' });

  const mock = await startHttpMock((request, requests) => {
    if (request.method === 'PUT' && request.url === '/api/processes/agent-1/demo/artifact') {
      assert.match(request.body.run_js, /doubled/);
      assert.equal(request.body.manifest.version, 1);
      return { body: { success: true, manifest: { ...request.body.manifest, status: 'draft' } } };
    }
    if (request.method === 'POST' && request.url === '/api/processes/agent-1/demo/records') {
      return { body: { success: true, record: request.body, records: requests.filter((r) => r.url.endsWith('/records')).length } };
    }
    if (request.method === 'POST' && request.url === '/api/processes/agent-1/demo/backtest') {
      return {
        body: {
          success: true,
          name: 'demo',
          result: { version: 1, total: 2, passed: 2, accuracy: 1, threshold: 0.99, failures: [] },
          manifest: { name: 'demo', version: 1, status: 'draft' },
          failureCount: 0,
        },
      };
    }
    return { status: 404, body: { detail: `unexpected ${request.method} ${request.url}` } };
  });

  try {
    const env = cliEnv({
      ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      ATRIS_TOKEN: 'test-token',
    });
    const first = await runCliAsync(['compile', 'publish', 'demo', '--agent', 'agent-1'], { cwd: root, env });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /published artifact demo to server \(draft\)/);
    assert.match(first.stdout, /pushed 2 new records \(2 total local\)/);
    assert.match(first.stdout, /server backtest demo v1: 2\/2 passed \(100\.00%\), gate 99\.00%, status draft/);
    assert.match(first.stdout, /next: promote on server with "atris compile promote demo --server --agent agent-1"/);
    assert.equal(mock.requests.every((request) => request.authorization === 'Bearer test-token'), true);
    assert.equal(mock.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/records')).length, 2);
    const firstRecordBodies = mock.requests
      .filter((request) => request.method === 'POST' && request.url.endsWith('/records'))
      .map((request) => request.body);
    assert.match(firstRecordBodies[0].record_key, /^compile-record-v1:[a-f0-9]{64}$/);
    assert.match(firstRecordBodies[1].record_key, /^compile-record-v1:[a-f0-9]{64}$/);
    assert.notEqual(firstRecordBodies[0].record_key, firstRecordBodies[1].record_key);

    const cursorState = readPushCursorState(root, 'demo');
    const cursor = Object.values(cursorState.contexts)[0];
    assert.equal(cursorState.version, 1);
    assert.equal(cursor.nextRecordIndex, 2);
    assert.equal(cursor.agent_id, 'agent-1');
    assert.equal(cursor.api_base, `http://127.0.0.1:${mock.port}/api`);

    const requestCount = mock.requests.length;
    const second = await runCliAsync(['compile', 'publish', 'demo', '--agent', 'agent-1'], { cwd: root, env });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /records up to date \(2 already pushed\)/);
    const secondRequests = mock.requests.slice(requestCount);
    assert.equal(secondRequests.filter((request) => request.method === 'POST' && request.url.endsWith('/records')).length, 0);
    assert.equal(secondRequests.filter((request) => request.method === 'PUT' && request.url.endsWith('/artifact')).length, 1);
    assert.equal(secondRequests.filter((request) => request.method === 'POST' && request.url.endsWith('/backtest')).length, 1);
  } finally {
    await closeServer(mock.server);
  }
});

test('publish keeps record cursors separate when alternating publish targets', async () => {
  const root = makeRoot();
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  appendRecord(root, 'demo', { input: { n: 1 }, output: { doubled: 2 } });
  appendRecord(root, 'demo', { input: { n: 2 }, output: { doubled: 4 } });

  const mock = await startHttpMock((request) => {
    const match = request.url.match(/^\/api\/processes\/([^/]+)\/demo\/(artifact|records|backtest)$/);
    if (!match) return { status: 404, body: { detail: `unexpected ${request.method} ${request.url}` } };
    const action = match[2];
    if (request.method === 'PUT' && action === 'artifact') {
      return { body: { success: true, manifest: { ...request.body.manifest, status: 'draft' } } };
    }
    if (request.method === 'POST' && action === 'records') {
      return { body: { success: true, record: request.body } };
    }
    if (request.method === 'POST' && action === 'backtest') {
      return {
        body: {
          success: true,
          result: { version: 1, total: 2, passed: 2, accuracy: 1, threshold: 0.99, failures: [] },
          manifest: { name: 'demo', version: 1, status: 'draft' },
        },
      };
    }
    return { status: 404, body: { detail: `unexpected ${request.method} ${request.url}` } };
  });

  try {
    const env = cliEnv({
      ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      ATRIS_TOKEN: 'test-token',
    });
    const publish = (agent) => runCliAsync(['compile', 'publish', 'demo', '--agent', agent], { cwd: root, env });

    const first = await publish('agent-a');
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /pushed 2 new records \(2 total local\)/);

    const afterFirst = mock.requests.length;
    const second = await publish('agent-b');
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /pushed 2 new records \(2 total local\)/);
    const secondRequests = mock.requests.slice(afterFirst);
    assert.equal(secondRequests.filter((request) => request.method === 'POST' && request.url.endsWith('/records')).length, 2);

    const afterSecond = mock.requests.length;
    const third = await publish('agent-a');
    assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
    assert.match(third.stdout, /records up to date \(2 already pushed\)/);
    const thirdRequests = mock.requests.slice(afterSecond);
    assert.equal(thirdRequests.filter((request) => request.method === 'POST' && request.url.endsWith('/records')).length, 0);

    const state = readPushCursorState(root, 'demo');
    const cursors = Object.values(state.contexts);
    assert.equal(cursors.length, 2);
    assert.deepEqual(cursors.map((cursor) => cursor.agent_id).sort(), ['agent-a', 'agent-b']);
    assert.deepEqual(cursors.map((cursor) => cursor.nextRecordIndex).sort(), [2, 2]);
  } finally {
    await closeServer(mock.server);
  }
});

test('publish advances the push cursor after each successful record post', async () => {
  const root = makeRoot();
  writeRunner(root, 'demo', DOUBLER);
  const manifest = defaultManifest('demo');
  manifest.version = 1;
  writeManifest(root, 'demo', manifest);
  appendRecord(root, 'demo', { input: { n: 1 }, output: { doubled: 2 } });
  appendRecord(root, 'demo', { input: { n: 2 }, output: { doubled: 4 } });

  let failedSecondRecordOnce = false;
  const recordBodies = [];
  const mock = await startHttpMock((request) => {
    if (request.method === 'PUT' && request.url === '/api/processes/agent-1/demo/artifact') {
      return { body: { success: true, manifest: { ...request.body.manifest, status: 'draft' } } };
    }
    if (request.method === 'POST' && request.url === '/api/processes/agent-1/demo/records') {
      recordBodies.push(request.body);
      if (!failedSecondRecordOnce && recordBodies.length === 2) {
        failedSecondRecordOnce = true;
        return { status: 500, body: { error: 'simulated record write failure' } };
      }
      return { body: { success: true, record: request.body } };
    }
    if (request.method === 'POST' && request.url === '/api/processes/agent-1/demo/backtest') {
      return {
        body: {
          success: true,
          result: { version: 1, total: 2, passed: 2, accuracy: 1, threshold: 0.99, failures: [] },
          manifest: { name: 'demo', version: 1, status: 'draft' },
        },
      };
    }
    return { status: 404, body: { detail: `unexpected ${request.method} ${request.url}` } };
  });

  try {
    const env = cliEnv({
      ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      ATRIS_TOKEN: 'test-token',
    });
    const first = await runCliAsync(['compile', 'publish', 'demo', '--agent', 'agent-1'], { cwd: root, env });
    assert.notEqual(first.status, 0);
    const cursorAfterFailure = Object.values(readPushCursorState(root, 'demo').contexts)[0];
    assert.equal(cursorAfterFailure.nextRecordIndex, 1);

    const beforeRetry = mock.requests.length;
    const retry = await runCliAsync(['compile', 'publish', 'demo', '--agent', 'agent-1'], { cwd: root, env });
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.match(retry.stdout, /pushed 1 new record \(2 total local\)/);
    const retryRecordRequests = mock.requests
      .slice(beforeRetry)
      .filter((request) => request.method === 'POST' && request.url.endsWith('/records'));
    assert.equal(retryRecordRequests.length, 1);
    assert.equal(retryRecordRequests[0].body.record_key, recordBodies[1].record_key);
    const cursorAfterRetry = Object.values(readPushCursorState(root, 'demo').contexts)[0];
    assert.equal(cursorAfterRetry.nextRecordIndex, 2);
  } finally {
    await closeServer(mock.server);
  }
});

test('schedule sends cron and input payload to the server', async () => {
  const root = makeRoot();
  let captured = null;
  const mock = await startHttpMock((request) => {
    captured = request;
    if (request.method === 'POST' && request.url === '/api/processes/agent-1/demo/schedule') {
      return { body: { success: true, schedule: { id: 'sched-123' } } };
    }
    return { status: 404, body: { detail: 'unexpected request' } };
  });

  try {
    const env = cliEnv({
      ATRIS_API_URL: `http://127.0.0.1:${mock.port}/api`,
      ATRIS_TOKEN: 'test-token',
    });
    const res = await runCliAsync([
      'compile', 'schedule', 'demo',
      '--agent', 'agent-1',
      '--cron', '*/5 * * * *',
      '--input', '{"n":1}',
    ], { cwd: root, env });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(captured.authorization, 'Bearer test-token');
    assert.deepEqual(captured.body, { cron: '*/5 * * * *', input: { n: 1 } });
    assert.match(res.stdout, /scheduled demo: sched-123/);
  } finally {
    await closeServer(mock.server);
  }
});

test('publish without auth exits non-zero with a helpful message', () => {
  const root = makeRoot();
  writeRunner(root, 'demo', DOUBLER);
  writeManifest(root, 'demo', defaultManifest('demo'));
  const res = runCli(['compile', 'publish', 'demo', '--agent', 'agent-1'], {
    cwd: root,
    env: cliEnv({ ATRIS_API_URL: 'http://127.0.0.1:9/api' }),
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Missing Atris auth/);
  assert.match(res.stderr, /atris login or set ATRIS_TOKEN/);
});
