// Tests must never touch the real ~/.atris state. When a test forgets to set
// ATRIS_TASKS_DB (or HOME), the CLI it spawns runs under the node test runner
// with the user's real home, and used to open ~/.atris/tasks.db for write.
// These tests pin the fence: under the test runner, the real home is swapped
// for a throwaway state folder unless the caller opts in on purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function cleanEnv(extra) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  delete env.ATRIS_TASKS_DB;
  delete env.ATRIS_TEST_STATE_DIR;
  delete env.ATRIS_TEST_REAL_HOME;
  return { ...env, ...extra };
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd, env, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
}

function snapshot(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs, bytes: fs.readFileSync(file).toString('hex') };
}

test('a CLI spawned by a test with the real home never writes the real task db', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fence-test-'));
  // Stand-in for the user's real home, holding a sentinel tasks.db.
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  const sentinel = path.join(home, '.atris', 'tasks.db');
  fs.writeFileSync(sentinel, 'sentinel: the real task database\n');
  const before = snapshot(sentinel);
  const stateDir = path.join(root, 'fenced');
  try {
    const env = cleanEnv({
      HOME: home,
      ATRIS_TEST_PROTECTED_HOME: home,
      ATRIS_TEST_STATE_DIR: stateDir,
    });
    const add = runCli(['task', 'add', 'fence probe task'], { cwd: workspace, env });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const where = runCli(['task', 'where', '--json'], { cwd: workspace, env });
    assert.equal(where.status, 0, where.stderr || where.stdout);
    const db = JSON.parse(where.stdout).db;
    assert.equal(db, path.join(stateDir, '.atris', 'tasks.db'));
    assert.ok(fs.existsSync(db), 'the task landed in the fenced db');
    const list = runCli(['task', 'list', '--json'], { cwd: workspace, env });
    assert.match(list.stdout, /fence probe task/);

    assert.deepEqual(snapshot(sentinel), before, 'real tasks.db must be untouched');
    assert.deepEqual(fs.readdirSync(path.join(home, '.atris')), ['tasks.db'], 'no wal/shm next to the real db');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('with no override at all, CLI runs from separate shells share one fenced db', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fence-test-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  // A private TMPDIR keeps this test off the shared per-user fence folder
  // while still exercising the default path math.
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  fs.mkdirSync(tmp);
  const sentinel = path.join(home, '.atris', 'tasks.db');
  fs.writeFileSync(sentinel, 'sentinel\n');
  const before = snapshot(sentinel);
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username;
  const expected = path.join(tmp, `atris-test-home-${uid}`, '.atris', 'tasks.db');
  // `true;` forces each shell to fork instead of exec, so every CLI has a
  // different parent than this test file.
  const shell = (args) => spawnSync('/bin/sh', ['-c', `true; "${process.execPath}" "${cliPath}" ${args}`], {
    cwd: workspace,
    env: cleanEnv({ HOME: home, ATRIS_TEST_PROTECTED_HOME: home, TMPDIR: tmp }),
    encoding: 'utf8',
    timeout: 30000,
  });
  try {
    const add = shell("task add 'shell fence probe'");
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const where = shell('task where --json');
    assert.equal(where.status, 0, where.stderr || where.stdout);
    assert.equal(JSON.parse(where.stdout).db, expected);
    const list = shell('task list --json');
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /shell fence probe/);
    assert.deepEqual(snapshot(sentinel), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('in-process resolution under the test runner points away from the real home', () => {
  // No HOME override here: this is the real user home, read-only path math.
  const stateHome = require('../lib/state-home');
  const taskDb = require('../lib/task-db');
  const saved = process.env.ATRIS_TASKS_DB;
  delete process.env.ATRIS_TASKS_DB;
  try {
    const realHome = os.userInfo().homedir;
    assert.ok(process.env.NODE_TEST_CONTEXT, 'runs under node --test');
    assert.notEqual(stateHome.stateHome(), realHome);
    assert.ok(!taskDb.getDbPath().startsWith(path.join(realHome, '.atris')), taskDb.getDbPath());
  } finally {
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
  }
});

test('explicit overrides still win: ATRIS_TASKS_DB, a temp HOME, and the real-home opt-in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fence-test-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  try {
    const where = (extra) => {
      const r = runCli(['task', 'where', '--json'], { cwd: workspace, env: cleanEnv(extra) });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return JSON.parse(r.stdout).db;
    };
    const explicit = path.join(root, 'explicit.db');
    assert.equal(where({ HOME: home, ATRIS_TEST_PROTECTED_HOME: home, ATRIS_TASKS_DB: explicit }), explicit);
    // A temp HOME is already isolated, so it keeps its own ~/.atris.
    assert.equal(where({ HOME: home }), path.join(home, '.atris', 'tasks.db'));
    // Deliberately exercising the default path needs the opt-in.
    assert.equal(
      where({ HOME: home, ATRIS_TEST_PROTECTED_HOME: home, ATRIS_TEST_REAL_HOME: '1' }),
      path.join(home, '.atris', 'tasks.db'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ax logs and approvals, radar business cache, and the ytrail bench stay off the real home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fence-test-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  const stateDir = path.join(root, 'fenced');
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.atris'), { recursive: true });
  // Real-home data radar must not read under the fence.
  fs.writeFileSync(path.join(home, '.atris', 'businesses.json'),
    JSON.stringify({ 'fence-co': { name: 'REAL HOME LEAK', business_id: 'real-home-leak' } }));
  fs.writeFileSync(path.join(workspace, '.atris', 'business.json'), JSON.stringify({ slug: 'fence-co' }));
  const probe = `
    const ax = require(${JSON.stringify(path.join(repoRoot, 'ax'))});
    const radar = require(${JSON.stringify(path.join(repoRoot, 'commands', 'radar.js'))});
    const logger = ax.createRunLogger({ cwd: ${JSON.stringify(workspace)}, output: process.stderr });
    if (logger && typeof logger.close === 'function') logger.close();
    const data = radar.collectRadar({ root: ${JSON.stringify(workspace)} });
    process.stdout.write(JSON.stringify({
      approvals: ax.approvalStorePath(),
      leaked: JSON.stringify(data).includes('REAL HOME LEAK'),
    }));
  `;
  const run = (extra) => {
    const r = spawnSync(process.execPath, ['-e', probe], {
      cwd: workspace, encoding: 'utf8', timeout: 30000,
      env: cleanEnv({ HOME: home, ATRIS_TEST_PROTECTED_HOME: home, ...extra }),
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  try {
    const fenced = run({ ATRIS_TEST_STATE_DIR: stateDir });
    assert.equal(fenced.approvals, path.join(stateDir, '.atris', 'ax-approvals.json'));
    assert.equal(fenced.leaked, false, 'radar read businesses.json from the real home');
    assert.ok(fs.readdirSync(path.join(stateDir, '.atris', 'runs')).length > 0, 'ax run log went to the fence');
    assert.ok(!fs.existsSync(path.join(home, '.atris', 'runs')), 'no ax run log in the real home');

    const bench = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'det', 'ytrail-bench.js'), '--case', 'stranger-no-downloader'], {
      cwd: workspace, encoding: 'utf8', timeout: 60000,
      env: cleanEnv({ HOME: home, ATRIS_TEST_PROTECTED_HOME: home, ATRIS_TEST_STATE_DIR: stateDir, YTRAIL_OUT_DIR: '' }),
    });
    assert.ok(fs.existsSync(path.join(stateDir, '.atris', 'benchmarks', 'ytrail.jsonl')), bench.stderr || bench.stdout);
    assert.ok(!fs.existsSync(path.join(home, '.atris', 'benchmarks')), 'no bench receipt in the real home');

    // Control: with the opt-in, the same probe does see the real-home data,
    // so the leak check above is live.
    const optedIn = run({ ATRIS_TEST_REAL_HOME: '1', AX_AUTO_LOG: '0' });
    assert.equal(optedIn.leaked, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
