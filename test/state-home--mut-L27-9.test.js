const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testStateFenced } = require('../lib/state-home');

test('an unavailable current home does not match a protected folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-home-'));
  const savedHome = process.env.HOME;
  const savedHomedir = os.homedir;
  process.env.HOME = root;
  // An empty HOME can make the OS home lookup return an empty string.
  os.homedir = () => '';
  try {
    assert.strictEqual(testStateFenced({
      NODE_TEST_CONTEXT: 'child-v8',
      ATRIS_TEST_PROTECTED_HOME: root,
    }), false);
  } finally {
    os.homedir = savedHomedir;
    if (savedHome !== undefined) process.env.HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
