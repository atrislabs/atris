const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const gmBet = require('../lib/gm-bet');

test('model timeout: MODEL_TIMEOUT_MS is a whole number of milliseconds', () => {
  assert.strictEqual(gmBet.MODEL_TIMEOUT_MS, 120000);
  assert.strictEqual(Number.isSafeInteger(gmBet.MODEL_TIMEOUT_MS), true);
  // runModel reports the timeout in whole seconds, so it must divide cleanly
  assert.strictEqual(gmBet.MODEL_TIMEOUT_MS % 1000, 0);
  assert.strictEqual(Math.round(gmBet.MODEL_TIMEOUT_MS / 1000), 120);
});

test('model timeout: the value sits inside the bounds a spawn timeout needs', () => {
  // zero or negative would fire the kill timer before the model could answer
  assert.strictEqual(gmBet.MODEL_TIMEOUT_MS > 0, true);
  assert.strictEqual(Number.isFinite(gmBet.MODEL_TIMEOUT_MS), true);
  // past ten minutes a hung model would hold the desk for too long
  assert.strictEqual(gmBet.MODEL_TIMEOUT_MS <= 10 * 60 * 1000, true);
});

test('model timeout: runModel arms its kill timer with MODEL_TIMEOUT_MS by default', async () => {
  const delays = [];
  const realSetTimeout = global.setTimeout;
  const child = new EventEmitter();
  child.pid = 987654;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  let pending;
  global.setTimeout = (fn, ms) => { delays.push(ms); return { fn }; };
  try {
    pending = gmBet.runModel('prompt', { spawnFn: () => child, kill: () => {}, env: {} });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  child.emit('close', 0);
  const res = await pending;
  assert.deepEqual(delays, [gmBet.MODEL_TIMEOUT_MS]);
  assert.deepEqual(res, { ok: false, reason: 'the model gave an empty answer' });
});
