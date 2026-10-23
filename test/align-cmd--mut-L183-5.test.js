'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

let customApiRequestJson = null;
const origApiRequestJson = api.apiRequestJson;
api.apiRequestJson = async (...args) => {
  if (customApiRequestJson) {
    return customApiRequestJson(...args);
  }
  return origApiRequestJson.apply(api, args);
};

const { alignAtris } = require('../commands/align');

class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

test('alignAtris ensureAwake terminates at exact timeout boundary when wait time reaches maxWaitSec', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mut-'));
  fs.mkdirSync(path.join(tmpDir, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.atris', 'business.json'),
    JSON.stringify({ slug: 'example-co' })
  );

  const savedEnv = {
    HOME: process.env.HOME,
    ATRIS_TOKEN: process.env.ATRIS_TOKEN,
  };
  process.env.HOME = tmpDir;
  process.env.ATRIS_TOKEN = 'mock-token';

  const origCwd = process.cwd();
  process.chdir(tmpDir);

  const origArgv = process.argv;
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write;
  const origSetTimeout = global.setTimeout;
  const origDateNow = Date.now;
  const origApiRequestJson = api.apiRequestJson;

  const logs = [];
  const errors = [];
  let exitCode = null;

  process.argv = ['node', 'atris', 'align', 'example-co'];
  process.exit = (code) => {
    exitCode = code === undefined ? 0 : code;
    throw new ExitError(exitCode);
  };
  console.log = (...args) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
  };
  process.stdout.write = (chunk) => {
    logs.push(String(chunk));
    return true;
  };
  global.setTimeout = (fn) => setImmediate(fn);

  let dateCalls = 0;
  const baseTime = 1000000;
  Date.now = () => {
    dateCalls++;
    if (dateCalls === 1) return baseTime;
    return baseTime + 90000;
  };

  let wakeStatusCalls = 0;
  customApiRequestJson = async (endpoint) => {
    if (endpoint === '/business/') {
      return {
        ok: true,
        data: [{ slug: 'example-co', id: 'biz-1', workspace_id: 'ws-1', name: 'Example Co' }],
      };
    }
    if (endpoint === '/business/biz-1/ai-computer/status') {
      wakeStatusCalls++;
      if (wakeStatusCalls === 1) {
        return { ok: true, data: { status: 'stopped' } };
      }
      return { ok: true, data: { status: 'running', endpoint: 'https://ec2.example.com' } };
    }
    if (endpoint === '/business/biz-1/ai-computer/wake') {
      return { ok: true };
    }
    if (endpoint.includes('/snapshot')) {
      return { ok: true, data: { files: [] } };
    }
    return { ok: true, data: {} };
  };

  try {
    await alignAtris();
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
  } finally {
    process.argv = origArgv;
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
    global.setTimeout = origSetTimeout;
    Date.now = origDateNow;
    api.apiRequestJson = origApiRequestJson;
    customApiRequestJson = null;
    process.chdir(origCwd);
    process.env.HOME = savedEnv.HOME;
    if (savedEnv.ATRIS_TOKEN === undefined) delete process.env.ATRIS_TOKEN;
    else process.env.ATRIS_TOKEN = savedEnv.ATRIS_TOKEN;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const out = logs.join('');
  const err = errors.join('\n');

  assert.strictEqual(exitCode, 1);
  assert.match(out, /timeout/);
  assert.doesNotMatch(out, /awake/);
  assert.match(
    err,
    /The cloud computer for "example-co" did not wake up in time, so nothing ran\./
  );
});
