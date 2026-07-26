const test = require('node:test');
const assert = require('node:assert');
const { shipWithRetry, shipFailureDetail } = require('../lib/fleet');

const LOADER_STACK = [
  "node:internal/modules/cjs/loader:1899",
  "Error: Cannot find module '/Users/x/arena/atris-cli/lib/voice-gate.js'",
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1899:10)",
  "    at Module.load (node:internal/modules/cjs/loader:1469:32)",
].join('\n');

test('a transient module-not-found ship is retried once and can succeed', () => {
  const calls = [];
  const cli = () => {
    calls.push(1);
    return calls.length === 1
      ? { status: 1, stdout: '', stderr: LOADER_STACK }
      : { status: 0, stdout: 'done: worktree shipped', stderr: '' };
  };
  const shipped = shipWithRetry(cli, ['worktree', 'ship'], '/tmp');
  assert.strictEqual(calls.length, 2, 'retried exactly once');
  assert.strictEqual(shipped.status, 0);
});

test('a normal ship failure is not retried', () => {
  const calls = [];
  const cli = () => { calls.push(1); return { status: 1, stdout: '', stderr: 'rebase conflict' }; };
  shipWithRetry(cli, ['worktree', 'ship'], '/tmp');
  assert.strictEqual(calls.length, 1);
});

test('failure detail always names the missing module, even when clipping would drop it', () => {
  const padding = 'x'.repeat(2000);
  const shipped = { status: 1, stderr: `${LOADER_STACK}\n${padding}`, stdout: '', retried_module_not_found: true };
  const detail = shipFailureDetail(shipped, { head: 40, tail: 40 });
  assert.match(detail, /Cannot find module '\/Users\/x\/arena\/atris-cli\/lib\/voice-gate\.js'/);
  assert.match(detail, /persisted after one retry/);
});
