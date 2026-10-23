const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { appsCommand } = require('../commands/apps');

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function runCaptured(t, fn) {
  const captured = { stdout: '', stderr: '', code: null };
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...args) => { captured.stdout += args.join(' ') + '\n'; };
  console.error = (...args) => { captured.stderr += args.join(' ') + '\n'; };
  process.exit = (code = 0) => { captured.code = code; throw new ExitSignal(code); };
  const restore = () => {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  };
  t.after(restore);
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    restore();
  }
  return captured;
}

test('appsCommand load parses key=value option at first position', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-mut-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const prevCwd = process.cwd();
  process.chdir(tmpDir);
  t.after(() => process.chdir(prevCwd));

  const res = await runCaptured(t, () => appsCommand('load', '--filter=template', '--unknown', '--json'));
  assert.equal(res.code, 2);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'Unknown apps load option: --unknown');
});
