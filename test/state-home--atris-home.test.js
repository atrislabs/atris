const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { atrisHome } = require('../lib/state-home');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-home-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('atrisHome puts .atris inside the HOME it is given', () => {
  const home = path.join(root, 'plain-home');
  assert.strictEqual(atrisHome({ HOME: home }), path.join(home, '.atris'));
});

test('atrisHome tolerates a trailing slash on HOME', () => {
  const home = path.join(root, 'slash-home');
  assert.strictEqual(atrisHome({ HOME: `${home}/` }), path.join(home, '.atris'));
});

test('atrisHome falls back to os.homedir() when env has no usable HOME', () => {
  const fakeHome = path.join(root, 'os-homedir');
  const realHomedir = os.homedir;
  os.homedir = () => fakeHome;
  try {
    assert.strictEqual(atrisHome({}), path.join(fakeHome, '.atris'));
    assert.strictEqual(atrisHome({ HOME: '' }), path.join(fakeHome, '.atris'));
  } finally {
    os.homedir = realHomedir;
  }
});

test('atrisHome under the test runner returns the fence folder when HOME is a protected home', () => {
  const home = path.join(root, 'protected-home');
  const fence = path.join(root, 'fence');
  const env = {
    NODE_TEST_CONTEXT: '1',
    HOME: home,
    ATRIS_TEST_PROTECTED_HOME: home,
    ATRIS_TEST_STATE_DIR: fence,
  };
  assert.strictEqual(atrisHome(env), path.join(fence, '.atris'));
});

test('atrisHome keeps the given HOME when ATRIS_TEST_REAL_HOME=1 opts out of the fence', () => {
  const home = path.join(root, 'opt-out-home');
  const env = {
    NODE_TEST_CONTEXT: '1',
    ATRIS_TEST_REAL_HOME: '1',
    HOME: home,
    ATRIS_TEST_PROTECTED_HOME: home,
    ATRIS_TEST_STATE_DIR: path.join(root, 'unused-fence'),
  };
  assert.strictEqual(atrisHome(env), path.join(home, '.atris'));
});

test('atrisHome does not redirect a test HOME that is not a protected home', () => {
  const home = path.join(root, 'ordinary-test-home');
  const env = {
    NODE_TEST_CONTEXT: '1',
    HOME: home,
    ATRIS_TEST_STATE_DIR: path.join(root, 'unused-fence-2'),
  };
  assert.strictEqual(atrisHome(env), path.join(home, '.atris'));
});
