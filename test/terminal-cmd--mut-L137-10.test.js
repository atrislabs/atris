'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

test('parses --timeout from argument following the flag and reports configured seconds on timeout', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-terminal-mut-'));
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const origApiRequestJson = api.apiRequestJson;

  api.apiRequestJson = async (pathname) => {
    if (pathname === '/business/') {
      return {
        ok: true,
        data: [{ id: 'biz-1', workspace_id: 'ws-1', slug: 'example-co', name: 'example-co' }],
      };
    }
    if (pathname.includes('/ai-computer/status')) {
      return {
        ok: true,
        data: { status: 'running', endpoint: 'http://127.0.0.1' },
      };
    }
    if (pathname.includes('/terminal')) {
      return {
        ok: true,
        data: { stdout: '', stderr: '', timed_out: true, exit_code: 124 },
      };
    }
    return { ok: false };
  };

  const { terminalAtris } = require('../commands/terminal');

  process.env.HOME = root;
  process.env.ATRIS_TOKEN = 'test-token';
  process.chdir(root);

  const stdout = [];
  const stderr = [];
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.argv = ['node', 'atris', 'terminal', '--account', 'example-co', 'echo hello', '--timeout', '45'];
  process.exit = (code) => { throw new ExitSignal(code === undefined ? 0 : code); };
  console.log = (...parts) => stdout.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };

  let exitCode = null;
  try {
    await terminalAtris();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitCode = error.code;
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    api.apiRequestJson = origApiRequestJson;

    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, 124);
  const errOutput = stderr.join('\n');
  assert.match(errOutput, /\[timed out after 45s\]/);
});
