const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testStateFenced } = require('../lib/state-home');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-state-fenced-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Supply a complete environment so ambient test and Atris settings cannot
  // affect the result. The protected-home seam avoids using the account home.
  return { HOME: home, ATRIS_TEST_PROTECTED_HOME: home };
}

test('fences a protected home only when a test marker is present', (t) => {
  const env = fixture(t);
  assert.strictEqual(testStateFenced(env), false);
  assert.strictEqual(testStateFenced({ ...env, NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.strictEqual(testStateFenced({ ...env, ATRIS_TEST_STATE_DIR: path.join(env.HOME, 'state') }), true);
  assert.strictEqual(testStateFenced({ ...env, NODE_TEST_CONTEXT: '', ATRIS_TEST_STATE_DIR: '' }), false);
});

test('keeps an explicitly isolated home outside the fence', (t) => {
  const env = fixture(t);
  const isolated = path.join(env.HOME, 'isolated');
  fs.mkdirSync(isolated);
  assert.strictEqual(testStateFenced({ ...env, HOME: isolated, NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.strictEqual(testStateFenced({ ...env, HOME: path.join(isolated, 'missing'), NODE_TEST_CONTEXT: 'child-v8' }), false);
});

test('recognizes a symlink spelling of the protected home', (t) => {
  const env = fixture(t);
  const target = path.join(env.HOME, 'target');
  const alias = path.join(env.HOME, 'alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, 'junction');
  assert.strictEqual(testStateFenced({ ...env, HOME: alias, ATRIS_TEST_PROTECTED_HOME: target, NODE_TEST_CONTEXT: 'child-v8' }), true);
});

test('only the exact real-home opt-out disables an active fence', (t) => {
  const env = { ...fixture(t), NODE_TEST_CONTEXT: 'child-v8' };
  assert.strictEqual(testStateFenced({ ...env, ATRIS_TEST_REAL_HOME: '1' }), false);
  assert.strictEqual(testStateFenced({ ...env, ATRIS_TEST_REAL_HOME: '0' }), true);
  assert.strictEqual(testStateFenced({ ...env, ATRIS_TEST_REAL_HOME: '' }), true);
});
