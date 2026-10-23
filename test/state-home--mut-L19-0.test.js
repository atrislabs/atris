const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { testStateFenced } = require('../lib/state-home');

test('recognizes case variations of protected home on case folding platforms', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-fold-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'target');
  const upper = path.join(root, 'TARGET');
  const env = {
    NODE_TEST_CONTEXT: '1',
    HOME: upper,
    ATRIS_TEST_PROTECTED_HOME: home,
  };
  assert.strictEqual(testStateFenced(env), true);
});
