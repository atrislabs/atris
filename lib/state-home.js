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
const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizedPath(p) {
  let resolved;
  try { resolved = fs.realpathSync(p); } catch (_) { resolved = path.resolve(p); }
  const foldCase = process.platform === 'darwin' || process.platform === 'win32';
  return foldCase ? resolved.toLowerCase() : resolved;
}

// Same folder under any spelling: symlinks, letter case, and macOS firmlinks
// like /System/Volumes/Data/Users/x, which realpath leaves alone but which
// share the device and inode of /Users/x.
function samePath(a, b) {
  if (!a || !b) return false;
  if (normalizedPath(a) === normalizedPath(b)) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch (_) {
    return false;
  }
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

// One fence folder per OS user, shared by every test run. Tests that need
// isolation already set their own paths; tests that did not were sharing the
// real db, so sharing one throwaway db keeps that behavior without the damage.
// The choice is exported through the env so children that lose
// NODE_TEST_CONTEXT still stay fenced.
function fenceDir(env) {
  if (env.ATRIS_TEST_STATE_DIR) return env.ATRIS_TEST_STATE_DIR;
  let user = typeof process.getuid === 'function' ? process.getuid() : null;
  if (user === null) {
    try { user = os.userInfo().username; } catch (_) { user = 'user'; }
  }
  const dir = path.join(os.tmpdir(), `atris-test-home-${user}`);
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
