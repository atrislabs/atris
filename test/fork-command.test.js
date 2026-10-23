const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { forkAtris } = require('../commands/fork');

const ENV_KEYS = [
  'HOME',
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_API_URL',
  'ATRIS_BACKEND_URL',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_AGENT_TOKEN_FILE',
];

function snapshotEnv(t) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function clearAuthEnv() {
  for (const key of ENV_KEYS) {
    if (key !== 'HOME') delete process.env[key];
  }
}

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// forkAtris calls process.exit on failure paths; turn it into a throw so the
// test process keeps running and the code can be asserted on.
function captureRun(t) {
  const state = { logs: [], errors: [], exitCode: null };
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const originalArgv = process.argv;
  const originalCwd = process.cwd();

  console.log = (...args) => state.logs.push(args.join(' '));
  console.error = (...args) => state.errors.push(args.join(' '));
  process.exit = (code) => {
    state.exitCode = code;
    const err = new Error(`process.exit(${code})`);
    err.isExit = true;
    throw err;
  };

  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.argv = originalArgv;
    process.chdir(originalCwd);
  });

  state.reset = () => {
    state.logs.length = 0;
    state.errors.length = 0;
    state.exitCode = null;
  };
  state.setArgs = (...args) => {
    process.argv = [process.argv[0], 'atris', 'fork', ...args];
  };
  state.run = async () => {
    try {
      await forkAtris();
    } catch (err) {
      if (!err || !err.isExit) throw err;
    }
    return state;
  };
  return state;
}

function useTempHome(t) {
  const home = makeTempDir(t, 'atris-fork-home-');
  snapshotEnv(t);
  process.env.HOME = home;
  clearAuthEnv();
  return home;
}

test('fork prints usage and exits 0 when the template arg is missing or a help flag', async (t) => {
  useTempHome(t);
  const run = captureRun(t);

  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    run.reset();
    run.setArgs(...args);
    await run.run();
    assert.strictEqual(run.exitCode, 0);
    assert.match(run.logs.join('\n'), /Usage: atris fork <template> \[target-dir\]/);
  }
});

test('fork exits 1 with a login message when no credentials exist', async (t) => {
  useTempHome(t);
  const run = captureRun(t);

  run.setArgs('demo');
  await run.run();

  assert.strictEqual(run.exitCode, 1);
  assert.match(run.errors.join('\n'), /Not logged in\. Run: atris login/);
});

test('fork exits 1 when the target directory exists and is not empty', async (t) => {
  useTempHome(t);
  const work = makeTempDir(t, 'atris-fork-work-');
  process.env.ATRIS_TOKEN = 'test-token';

  fs.mkdirSync(path.join(work, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(work, 'demo', 'existing.txt'), 'keep me');

  const run = captureRun(t);
  process.chdir(work);
  run.setArgs('demo');
  await run.run();

  assert.strictEqual(run.exitCode, 1);
  assert.match(run.errors.join('\n'), /Directory "demo" already exists and is not empty/);
  assert.strictEqual(fs.readFileSync(path.join(work, 'demo', 'existing.txt'), 'utf8'), 'keep me');
});

test('fork uses the local template when the API is unavailable and writes metadata', async (t) => {
  const home = useTempHome(t);
  const work = makeTempDir(t, 'atris-fork-work-');
  process.env.ATRIS_TOKEN = 'test-token';
  // Unparseable base URL: the request fails before a socket is ever opened.
  process.env.ATRIS_API_URL = 'atris-test-offline';

  const templateDir = path.join(home, '.atris', 'templates', 'demo');
  fs.mkdirSync(path.join(templateDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(templateDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(templateDir, 'README.md'), '# demo template\n');
  fs.writeFileSync(path.join(templateDir, 'docs', 'guide.md'), 'guide\n');
  fs.writeFileSync(path.join(templateDir, 'node_modules', 'junk.js'), 'skip me\n');

  const run = captureRun(t);
  process.chdir(work);
  run.setArgs('demo', 'myband');
  await run.run();

  assert.strictEqual(run.exitCode, null);

  const targetDir = path.join(work, 'myband');
  assert.strictEqual(fs.readFileSync(path.join(targetDir, 'README.md'), 'utf8'), '# demo template\n');
  assert.strictEqual(fs.readFileSync(path.join(targetDir, 'docs', 'guide.md'), 'utf8'), 'guide\n');
  assert.strictEqual(fs.existsSync(path.join(targetDir, 'node_modules', 'junk.js')), false);

  const business = JSON.parse(fs.readFileSync(path.join(targetDir, '.atris', 'business.json'), 'utf8'));
  assert.strictEqual(business.slug, 'myband');
  assert.strictEqual(business.forked_from, 'demo');

  const forkMeta = JSON.parse(fs.readFileSync(path.join(targetDir, '.atris', 'fork.json'), 'utf8'));
  assert.strictEqual(forkMeta.forked_from, 'demo');
  assert.ok(forkMeta.forked_at);

  const output = run.logs.join('\n');
  assert.match(output, /API unavailable, using local template/);
  assert.match(output, /2 files written to myband\//);
});
