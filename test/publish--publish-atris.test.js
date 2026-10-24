require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub the network seam before commands/publish binds it at require time.
const apiModule = require('../utils/api');
const apiCalls = [];
let apiHandler = async () => ({ ok: true, status: 200, data: {} });
apiModule.apiRequestJson = (pathname, options) => {
  apiCalls.push({ pathname, options });
  return apiHandler(pathname, options);
};

const { publishAtris } = require('../commands/publish');

class ExitSentinel extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'publish-atris-test-'));
}

// Runs publishAtris with argv, cwd, env, console, and process.exit swapped for
// test-owned doubles. Restores everything before returning.
async function runPublish({ cwd, argv = [], env = {}, stateDir }) {
  const logs = [];
  const errors = [];
  const exits = [];

  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const savedEnv = { ...process.env };

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = stateDir;
  process.env.ATRIS_TEST_STATE_DIR = stateDir;
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }

  process.argv = ['node', 'atris', 'publish', ...argv];
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => errors.push(parts.join(' '));
  process.exit = (code) => {
    exits.push(code);
    throw new ExitSentinel(code);
  };
  process.chdir(cwd);

  try {
    await publishAtris();
  } catch (err) {
    if (!(err instanceof ExitSentinel)) throw err;
  } finally {
    process.chdir(savedCwd);
    process.argv = savedArgv;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }

  return { logs, errors, exits };
}

test('exits 1 when not logged in', async () => {
  const workspace = makeTmpDir();
  const stateDir = makeTmpDir();
  fs.mkdirSync(path.join(workspace, 'atris'));

  const { errors, exits } = await runPublish({ cwd: workspace, stateDir });

  assert.deepStrictEqual(exits, [1]);
  assert.ok(
    errors.some((line) => line.includes('Not logged in')),
    `expected a not-logged-in error, got: ${JSON.stringify(errors)}`
  );
  assert.strictEqual(apiCalls.length, 0);
});

test('exits 1 when the atris directory is missing', async () => {
  const workspace = makeTmpDir();
  const stateDir = makeTmpDir();

  const { errors, exits } = await runPublish({
    cwd: workspace,
    stateDir,
    env: { ATRIS_TOKEN: 'test-token' },
  });

  assert.deepStrictEqual(exits, [1]);
  assert.ok(
    errors.some((line) => line.includes('No atris/ directory found')),
    `expected a missing-atris error, got: ${JSON.stringify(errors)}`
  );
});

test('exits 1 when atris holds only excluded files', async () => {
  const workspace = makeTmpDir();
  const stateDir = makeTmpDir();
  fs.mkdirSync(path.join(workspace, 'atris', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'atris', 'logs', 'run.txt'), 'log');
  fs.writeFileSync(path.join(workspace, 'atris', '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(workspace, 'atris', 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'atris', 'secrets', 'key.txt'), 'key');

  const { errors, exits } = await runPublish({
    cwd: workspace,
    stateDir,
    env: { ATRIS_TOKEN: 'test-token' },
  });

  assert.deepStrictEqual(exits, [1]);
  assert.ok(
    errors.some((line) => line.includes('No publishable files found')),
    `expected an empty-publish error, got: ${JSON.stringify(errors)}`
  );
  assert.strictEqual(apiCalls.length, 0);
});

test('publishes workspace files and saves a local copy', async () => {
  const workspace = makeTmpDir();
  const stateDir = makeTmpDir();
  fs.mkdirSync(path.join(workspace, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.atris', 'business.json'),
    JSON.stringify({ name: 'Acme Tools' })
  );
  fs.mkdirSync(path.join(workspace, 'atris', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'atris', 'atris.md'), '# hello\n');
  fs.writeFileSync(path.join(workspace, 'atris', 'nested', 'deep.txt'), 'deep');
  fs.mkdirSync(path.join(workspace, 'atris', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'atris', 'logs', 'skip.txt'), 'skip me');
  fs.writeFileSync(path.join(workspace, 'atris', '.env'), 'SECRET=1');

  apiCalls.length = 0;
  apiHandler = async () => ({ ok: true, status: 200, data: { id: 'tpl_1' } });

  const { logs, exits } = await runPublish({
    cwd: workspace,
    stateDir,
    argv: ['--description', 'a test template'],
    env: { ATRIS_TOKEN: 'test-token' },
  });

  assert.deepStrictEqual(exits, []);
  assert.strictEqual(apiCalls.length, 1);

  const { pathname, options } = apiCalls[0];
  assert.strictEqual(pathname, '/workspace/templates');
  assert.strictEqual(options.method, 'POST');
  assert.strictEqual(options.token, 'test-token');
  assert.strictEqual(options.body.name, 'Acme Tools');
  assert.strictEqual(options.body.description, 'a test template');

  const filePaths = options.body.files.map((f) => f.path).sort();
  assert.deepStrictEqual(filePaths, ['/atris.md', '/nested/deep.txt']);
  const atrisMd = options.body.files.find((f) => f.path === '/atris.md');
  assert.strictEqual(atrisMd.content, '# hello\n');

  const localDir = path.join(stateDir, '.atris', 'templates', 'acme-tools');
  assert.strictEqual(fs.readFileSync(path.join(localDir, 'atris.md'), 'utf8'), '# hello\n');
  assert.strictEqual(fs.readFileSync(path.join(localDir, 'nested', 'deep.txt'), 'utf8'), 'deep');

  const meta = JSON.parse(fs.readFileSync(path.join(localDir, 'template.json'), 'utf8'));
  assert.strictEqual(meta.name, 'Acme Tools');
  assert.strictEqual(meta.description, 'a test template');
  assert.strictEqual(meta.file_count, 2);
  assert.strictEqual(typeof meta.published_at, 'string');

  assert.ok(
    logs.some((line) => line.includes("Published as 'Acme Tools'")),
    `expected a published line, got: ${JSON.stringify(logs)}`
  );
});

test('exits 1 when the api rejects the publish', async () => {
  const workspace = makeTmpDir();
  const stateDir = makeTmpDir();
  fs.mkdirSync(path.join(workspace, 'atris'));
  fs.writeFileSync(path.join(workspace, 'atris', 'atris.md'), '# hi\n');

  apiCalls.length = 0;
  apiHandler = async () => ({ ok: false, status: 500, error: 'server boom' });

  const { errors, exits } = await runPublish({
    cwd: workspace,
    stateDir,
    argv: ['--name=Flag Name'],
    env: { ATRIS_TOKEN: 'test-token' },
  });

  assert.deepStrictEqual(exits, [1]);
  assert.strictEqual(apiCalls.length, 1);
  assert.strictEqual(apiCalls[0].options.body.name, 'Flag Name');
  assert.ok(
    errors.some((line) => line.includes('Publish failed')),
    `expected a publish-failed error, got: ${JSON.stringify(errors)}`
  );
  assert.ok(
    !fs.existsSync(path.join(stateDir, '.atris', 'templates')),
    'local template copy should not be written after a failed publish'
  );
});
