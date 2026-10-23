const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-align-command-'));
const savedHome = process.env.HOME;
const savedEnv = {};
for (const key of [
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_CLIENT_SECRET_FILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_TEST_REAL_HOME',
]) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
process.env.HOME = home;

const withBiz = path.join(home, 'with-biz');
const emptyDir = path.join(home, 'empty');
fs.mkdirSync(path.join(withBiz, '.atris'), { recursive: true });
fs.writeFileSync(
  path.join(withBiz, '.atris', 'business.json'),
  JSON.stringify({ slug: 'example-co' })
);
fs.mkdirSync(emptyDir);

const { alignAtris } = require('../commands/align');

class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function runAlign(argv, cwd) {
  return exclusive(async () => {
    const prevArgv = process.argv;
    const prevExit = process.exit;
    const prevCwd = process.cwd();
    const prevLog = console.log;
    const prevError = console.error;
    const logs = [];
    const errors = [];
    let exitCode = null;
    let timer;
    process.argv = argv;
    console.log = (...args) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    process.exit = (code) => {
      exitCode = code === undefined ? 0 : code;
      throw new ExitError(exitCode);
    };
    if (cwd) process.chdir(cwd);
    try {
      await Promise.race([
        alignAtris(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('align kept running')), 1000);
        }),
      ]);
    } catch (err) {
      if (!(err instanceof ExitError)) throw err;
    } finally {
      clearTimeout(timer);
      process.argv = prevArgv;
      process.exit = prevExit;
      console.log = prevLog;
      console.error = prevError;
      try { process.chdir(prevCwd); } catch {}
    }
    assert.notStrictEqual(exitCode, null, 'align returned without exiting');
    return {
      exitCode,
      out: logs.join('\n'),
      err: errors.join('\n'),
    };
  });
}

function assertUsage(out) {
  assert.match(out, /Usage: atris align \[business\] \[--fix\] \[--hard\] \[--from cloud\|local\] \[--dry-run\]/);
  assert.match(out, /atris align example-co --dry-run/);
  assert.equal(out.includes('Aligning'), false);
  assert.equal(out.includes('Waking'), false);
}

test('help prints usage and exits before any align, even when a business file is present', async () => {
  for (const arg of ['--help', '-h', 'help']) {
    const result = await runAlign(['node', 'atris', 'align', arg], withBiz);
    assert.equal(result.exitCode, 0, arg);
    assert.equal(result.err, '', arg);
    assertUsage(result.out);
  }
});

test('bad --from and --hard --from cloud exit with their errors', async () => {
  const badFrom = await runAlign(
    ['node', 'atris', 'align', 'example-co', '--from', 'sideways'],
    emptyDir
  );
  assert.equal(badFrom.exitCode, 1);
  assert.equal(badFrom.err, "Invalid --from value: sideways. Use 'local' or 'cloud'.");
  assert.equal(badFrom.out, '');

  const hardCloud = await runAlign(
    ['node', 'atris', 'align', 'example-co', '--fix', '--hard', '--from', 'cloud'],
    emptyDir
  );
  assert.equal(hardCloud.exitCode, 1);
  assert.match(hardCloud.err, /^--hard only works with --from local:/);
  assert.equal(hardCloud.out, '');
});

test('a missing workspace exits, and a bare flag with no business file prints usage', async () => {
  const missing = await runAlign(
    ['node', 'atris', 'align', 'align-test-missing-slug'],
    emptyDir
  );
  assert.equal(missing.exitCode, 1);
  assert.match(missing.err, /Cannot find local workspace for "align-test-missing-slug"\./);
  assert.match(missing.err, /Run from inside the workspace/);
  assert.equal(missing.out, '');

  const bareFlag = await runAlign(['node', 'atris', 'align', '--fix'], emptyDir);
  assert.equal(bareFlag.exitCode, 0);
  assert.equal(bareFlag.err, '');
  assertUsage(bareFlag.out);
});

test.after(() => {
  process.env.HOME = savedHome;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});
