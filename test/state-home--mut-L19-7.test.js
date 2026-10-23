const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { atrisHome } = require('../lib/state-home');

test('redirects case variations of protected home to the fence folder', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-fold-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'target');
  const upper = path.join(root, 'TARGET');
  const fence = path.join(root, 'fence');
  const env = {
    NODE_TEST_CONTEXT: '1',
    HOME: upper,
    ATRIS_TEST_PROTECTED_HOME: home,
    ATRIS_TEST_STATE_DIR: fence,
  };
  assert.strictEqual(atrisHome(env), path.join(fence, '.atris'));
});
