'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate environment before anything touches files or env
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-terminal-ensure-awake-'));
process.env.HOME = tempDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
});

// Mock api and auth before loading commands/terminal so destructured imports bind to mocks
const api = require('../utils/api');
const auth = require('../utils/auth');

let apiCalls = [];
let apiHandler = async () => ({ ok: false, error: 'unconfigured mock' });
api.apiRequestJson = async (pathname, options) => {
  apiCalls.push({ pathname, options });
  return apiHandler(pathname, options);
};

const originalAbortOnAuthFailure = auth.abortOnAuthFailure;
let authAbortHandler = null;
auth.abortOnAuthFailure = (result, printedWake, exitFn) => {
  if (authAbortHandler) {
    return authAbortHandler(result, printedWake, exitFn);
  }
  return originalAbortOnAuthFailure(result, printedWake, exitFn);
};

const { ensureAwake } = require('../commands/terminal');

async function captureOutput(fn) {
  const output = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origError = console.error;

  process.stdout.write = (chunk, encoding, callback) => {
    const str = String(chunk);
    if (str.includes('Waking EC2 computer')) {
      output.push(str);
      if (typeof callback === 'function') callback();
      return true;
    }
    return origWrite(chunk, encoding, callback);
  };
  console.log = (...args) => {
    output.push(args.join(' ') + '\n');
  };
  console.error = (...args) => {
    output.push(args.join(' ') + '\n');
  };

  try {
    const result = await fn();
    return { result, output: output.join('') };
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
    console.error = origError;
  }
}

test.beforeEach(() => {
  apiCalls = [];
  authAbortHandler = null;
});

test('ensureAwake returns true immediately when computer is already running with endpoint', async () => {
  apiHandler = async (pathname, options) => {
    assert.strictEqual(pathname, '/business/biz-running/ai-computer/status');
    assert.strictEqual(options.method, 'GET');
    assert.strictEqual(options.token, 'token-123');
    return {
      ok: true,
      status: 200,
      data: {
        status: 'running',
        endpoint: 'https://computer-1.example.com',
      },
    };
  };

  const { result, output } = await captureOutput(() =>
    ensureAwake('token-123', 'biz-running')
  );

  assert.strictEqual(result, true);
  assert.strictEqual(apiCalls.length, 1);
  assert.strictEqual(output, '');
});

test('ensureAwake wakes computer and returns true once running state with endpoint is reached', async () => {
  const origSetTimeout = global.setTimeout;
  // Eliminate sleep(3000) delay by executing immediately on next tick
  global.setTimeout = (fn, _ms, ...args) => origSetTimeout(fn, 0, ...args);

  try {
    let statusPolls = 0;
    apiHandler = async (pathname, options) => {
      assert.strictEqual(options.token, 'token-wake');
      if (pathname === '/business/biz-wake/ai-computer/wake') {
        assert.strictEqual(options.method, 'POST');
        return { ok: true, status: 200, data: { status: 'waking' } };
      }
      if (pathname === '/business/biz-wake/ai-computer/status') {
        assert.strictEqual(options.method, 'GET');
        statusPolls += 1;
        if (statusPolls === 1) {
          return { ok: true, status: 200, data: { status: 'stopped' } };
        }
        return {
          ok: true,
          status: 200,
          data: {
            status: 'running',
            endpoint: 'https://computer-woken.example.com',
          },
        };
      }
      throw new Error(`Unexpected path: ${pathname}`);
    };

    const { result, output } = await captureOutput(() =>
      ensureAwake('token-wake', 'biz-wake', 10)
    );

    assert.strictEqual(result, true);
    assert.strictEqual(apiCalls.length, 3);
    assert.strictEqual(apiCalls[0].pathname, '/business/biz-wake/ai-computer/status');
    assert.strictEqual(apiCalls[1].pathname, '/business/biz-wake/ai-computer/wake');
    assert.strictEqual(apiCalls[2].pathname, '/business/biz-wake/ai-computer/status');
    assert.match(output, /Waking EC2 computer\.\.\./);
    assert.match(output, /awake/);
  } finally {
    global.setTimeout = origSetTimeout;
  }
});

test('ensureAwake returns false when wake polling times out', async () => {
  apiHandler = async (pathname, options) => {
    assert.strictEqual(options.token, 'token-timeout');
    if (pathname === '/business/biz-timeout/ai-computer/status') {
      return { ok: true, status: 200, data: { status: 'stopped' } };
    }
    if (pathname === '/business/biz-timeout/ai-computer/wake') {
      return { ok: true, status: 200, data: { status: 'waking' } };
    }
    throw new Error(`Unexpected path: ${pathname}`);
  };

  // maxWaitSec = 0 causes the polling loop to exit immediately with timeout
  const { result, output } = await captureOutput(() =>
    ensureAwake('token-timeout', 'biz-timeout', 0)
  );

  assert.strictEqual(result, false);
  assert.strictEqual(apiCalls.length, 2);
  assert.strictEqual(apiCalls[0].pathname, '/business/biz-timeout/ai-computer/status');
  assert.strictEqual(apiCalls[1].pathname, '/business/biz-timeout/ai-computer/wake');
  assert.match(output, /Waking EC2 computer\.\.\./);
  assert.match(output, /timeout/);
});

test('ensureAwake does not treat running status without endpoint as awake', async () => {
  apiHandler = async (pathname) => {
    if (pathname === '/business/biz-no-endpoint/ai-computer/status') {
      return {
        ok: true,
        status: 200,
        data: {
          status: 'running',
          endpoint: null,
        },
      };
    }
    if (pathname === '/business/biz-no-endpoint/ai-computer/wake') {
      return { ok: true, status: 200, data: { status: 'waking' } };
    }
    throw new Error(`Unexpected path: ${pathname}`);
  };

  const { result, output } = await captureOutput(() =>
    ensureAwake('token-no-endpoint', 'biz-no-endpoint', 0)
  );

  assert.strictEqual(result, false);
  assert.strictEqual(apiCalls.length, 2);
  assert.match(output, /Waking EC2 computer\.\.\./);
  assert.match(output, /timeout/);
});

test('ensureAwake triggers auth failure check when initial status returns 401', async () => {
  let authFailed = false;
  authAbortHandler = (result, printedWake, exitFn) => {
    if (result && (result.status === 401 || result.status === 403)) {
      authFailed = true;
      throw new Error('AUTH_ABORTED_401');
    }
    return false;
  };

  apiHandler = async () => ({
    ok: false,
    status: 401,
    error: 'unauthorized',
  });

  await assert.rejects(
    () => captureOutput(() => ensureAwake('bad-token', 'biz-bad-auth')),
    /AUTH_ABORTED_401/
  );

  assert.strictEqual(authFailed, true);
  assert.strictEqual(apiCalls.length, 1);
});
