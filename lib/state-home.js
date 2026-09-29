// Where ~/.atris state lives, with a fence for test runs.
//
// The node test runner sets NODE_TEST_CONTEXT in every test-file process, and
// CLI subprocesses spawned by tests inherit it. A test that forgets to point
// ATRIS_TASKS_DB or HOME at a temp dir used to write the user's real task
// database. Under the test runner, when HOME is still the real user home, we
// hand back a throwaway home instead, so forgetting the override is safe.
//
// Explicit choices still win: a temp HOME keeps its own .atris, and
// ATRIS_TEST_REAL_HOME=1 opts a test back into the real home on purpose.
// Outside the test runner nothing changes.
const os = require('os');
const path = require('path');

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

function protectedHomes(env) {
  const homes = [];
  try { homes.push(os.userInfo().homedir); } catch (_) {}
  // Test seam that can only widen the fence: marks one more folder as a
  // real home, so a test can prove the fence without touching the real one.
  if (env.ATRIS_TEST_PROTECTED_HOME) homes.push(env.ATRIS_TEST_PROTECTED_HOME);
  return homes;
}

function underTest(env) {
  return Boolean(env.NODE_TEST_CONTEXT || env.ATRIS_TEST_STATE_DIR);
}

// os.homedir() follows HOME and any test mock of it; a caller-supplied env
// with its own HOME (like a spawned child's env) takes that instead.
function currentHome(env) {
  return (env !== process.env && env.HOME) || os.homedir();
}

function testStateFenced(env = process.env) {
  if (env.ATRIS_TEST_REAL_HOME === '1') return false;
  if (!underTest(env)) return false;
  const home = currentHome(env);
  const real = protectedHomes(env);
  // If we cannot tell who the real user is, assume HOME is real.
  if (real.length === 0) return true;
  return real.some((h) => samePath(home, h));
}

// The CLI spawned by a test file keys on its parent (the test file), so
// sibling CLI runs in one test file share state. Anything else keys on
// itself. The choice is exported through the env so descendants follow it.
function fenceDir(env) {
  if (env.ATRIS_TEST_STATE_DIR) return env.ATRIS_TEST_STATE_DIR;
  const main = require.main && require.main.filename;
  const isCli = Boolean(main)
    && path.basename(main) === 'atris.js'
    && path.basename(path.dirname(main)) === 'bin';
  const owner = isCli ? process.ppid : process.pid;
  const dir = path.join(os.tmpdir(), `atris-test-state-${owner}`);
  if (env === process.env) process.env.ATRIS_TEST_STATE_DIR = dir;
  return dir;
}

// The folder that holds .atris: the real home normally, a throwaway one when
// a test run would otherwise reach the real home.
function stateHome(env = process.env) {
  if (testStateFenced(env)) return fenceDir(env);
  return currentHome(env);
}

function atrisHome(env = process.env) {
  return path.join(stateHome(env), '.atris');
}

module.exports = { stateHome, atrisHome, testStateFenced };
