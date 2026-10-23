const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Start from no ATRIS_* vars so a developer's shell cannot change the result.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-review-out-root-'));
const home = path.join(tmp, 'home');
const fenceDir = path.join(tmp, 'fence');
const elsewhere = path.join(tmp, 'elsewhere');

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// DEFAULT_OUT_ROOT is computed once, when lib/deck-review.js is first required,
// from the env seen at that moment. Re-require the module under a chosen env,
// then restore the env so the next test starts clean.
function loadWithEnv(vars) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, vars);
    delete require.cache[require.resolve('../lib/deck-review')];
    return require('../lib/deck-review');
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('DEFAULT_OUT_ROOT is the .atris/deck-review folder under HOME', () => {
  const { DEFAULT_OUT_ROOT } = loadWithEnv({ HOME: home });
  assert.equal(typeof DEFAULT_OUT_ROOT, 'string');
  assert.ok(path.isAbsolute(DEFAULT_OUT_ROOT));
  assert.equal(DEFAULT_OUT_ROOT, path.join(home, '.atris', 'deck-review'));
});

test('DEFAULT_OUT_ROOT moves into the throwaway state dir when HOME is the real home', () => {
  // ATRIS_TEST_PROTECTED_HOME marks the temp home as "real", so the test-run
  // fence engages without touching the actual home folder.
  const { DEFAULT_OUT_ROOT } = loadWithEnv({
    HOME: home,
    ATRIS_TEST_PROTECTED_HOME: home,
    ATRIS_TEST_STATE_DIR: fenceDir,
  });
  assert.equal(DEFAULT_OUT_ROOT, path.join(fenceDir, '.atris', 'deck-review'));
  assert.ok(!DEFAULT_OUT_ROOT.startsWith(home + path.sep));
});

test('DEFAULT_OUT_ROOT is fixed at load time and does not follow a later HOME change', () => {
  const { DEFAULT_OUT_ROOT } = loadWithEnv({ HOME: home });
  const savedHome = process.env.HOME;
  process.env.HOME = elsewhere;
  try {
    assert.equal(DEFAULT_OUT_ROOT, path.join(home, '.atris', 'deck-review'));
    const reloaded = loadWithEnv({ HOME: elsewhere });
    assert.equal(reloaded.DEFAULT_OUT_ROOT, path.join(elsewhere, '.atris', 'deck-review'));
    assert.notEqual(reloaded.DEFAULT_OUT_ROOT, DEFAULT_OUT_ROOT);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
