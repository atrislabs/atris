'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The publish network call is the only thing stubbed. commands/publish picks up
// apiRequestJson when it loads, so the stub goes on the export before the
// require below.
const api = require('../utils/api');
const apiCalls = [];
let apiReply = { ok: true, status: 200, data: {} };
api.apiRequestJson = async (route, opts) => {
  apiCalls.push({ route, opts });
  return apiReply;
};

const { publishAtris } = require('../commands/publish');

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const CRED_ENV_KEYS = ['ATRIS_TOKEN', 'ATRIS_PROFILE', 'ATRIS_AGENT_TOKEN_FILE'];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-publish-cmd-test-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'my-studio');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);

  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalArgv = process.argv;
  const savedEnv = {};
  for (const key of CRED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  process.env.HOME = home;
  process.chdir(workspace);
  apiCalls.length = 0;
  apiReply = { ok: true, status: 200, data: {} };

  t.after(() => {
    process.chdir(originalCwd);
    process.argv = originalArgv;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const key of CRED_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { home, workspace };
}

function writeCredentials(home) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: 'test-token' }));
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function runPublish(args) {
  const out = [];
  const err = [];
  const originalArgv = process.argv;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode;

  process.argv = ['node', 'atris', 'publish', ...args];
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  process.exit = (code) => {
    throw new ExitSignal(code);
  };

  try {
    await publishAtris();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    exitCode = e.code;
  } finally {
    process.argv = originalArgv;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { code: exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('help flags print usage and exit 0 before any login check', async (t) => {
  const { home } = setup(t);
  // No credentials on disk: help must still work.
  assert.ok(!fs.existsSync(path.join(home, '.atris', 'credentials.json')));

  for (const flag of ['--help', '-h', 'help']) {
    const result = await runPublish([flag]);
    assert.strictEqual(result.code, 0, `exit code for ${flag}`);
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(result.stdout, [
      'Usage: atris publish [--name <name>] [--description <desc>]',
      '',
      '  atris publish                         Publish current workspace as a template',
      '  atris publish --name "CRM Starter"    Publish with a specific name',
      '  atris publish --name crm --description "Sales CRM template"',
    ].join('\n'));
  }
  assert.strictEqual(apiCalls.length, 0);
});

test('refuses to publish when not logged in and sends nothing', async (t) => {
  const { workspace } = setup(t);
  writeFile(workspace, 'atris/MAP.md', '# map');

  const result = await runPublish([]);
  assert.strictEqual(result.code, 1);
  assert.strictEqual(result.stderr, 'Not logged in. Run: atris login');
  assert.strictEqual(apiCalls.length, 0);
});

test('refuses to publish from a folder with no atris/ directory', async (t) => {
  const { home, workspace } = setup(t);
  writeCredentials(home);
  writeFile(workspace, 'notes/readme.md', 'not a workspace');

  const result = await runPublish([]);
  assert.strictEqual(result.code, 1);
  assert.strictEqual(result.stderr, 'No atris/ directory found. Run from a workspace root.');
  assert.strictEqual(apiCalls.length, 0);
});

test('publishes atris/ files and skips logs, env files, secrets, and large files', async (t) => {
  const { home, workspace } = setup(t);
  writeCredentials(home);
  writeFile(workspace, 'atris/MAP.md', '# map');
  writeFile(workspace, 'atris/now.md', 'now');
  writeFile(workspace, 'atris/team/member.md', 'member body');
  writeFile(workspace, 'atris/logs/2026/10-23.md', 'private journal');
  writeFile(workspace, 'atris/.env', 'TOKEN=secret');
  writeFile(workspace, 'atris/.env.local', 'TOKEN=secret');
  writeFile(workspace, 'atris/secrets/key.txt', 'key');
  writeFile(workspace, 'atris/big.txt', Buffer.alloc(600 * 1024, 'a'));

  const result = await runPublish(['--name', 'CRM Starter', '--description', 'Sales CRM template']);

  assert.strictEqual(result.code, undefined, 'success path does not exit');
  assert.strictEqual(apiCalls.length, 1);
  const [call] = apiCalls;
  assert.strictEqual(call.route, '/workspace/templates');
  assert.strictEqual(call.opts.method, 'POST');
  assert.strictEqual(call.opts.token, 'test-token');
  assert.strictEqual(call.opts.body.name, 'CRM Starter');
  assert.strictEqual(call.opts.body.description, 'Sales CRM template');

  const sentPaths = call.opts.body.files.map((f) => f.path).sort();
  assert.deepStrictEqual(sentPaths, ['/MAP.md', '/now.md', '/team/member.md']);
  const member = call.opts.body.files.find((f) => f.path === '/team/member.md');
  assert.strictEqual(member.content, 'member body');

  assert.match(result.stdout, /Publishing "CRM Starter" \(3 files\)\.\.\./);
  assert.match(result.stdout, /Published as 'CRM Starter'\. Others can fork with: atris fork CRM Starter/);
});

test('saves a local copy and template.json under a slugged name', async (t) => {
  const { home, workspace } = setup(t);
  writeCredentials(home);
  writeFile(workspace, 'atris/MAP.md', '# map');
  writeFile(workspace, 'atris/team/member.md', 'member body');

  const result = await runPublish(['--name', 'CRM Starter', '--description', 'Sales CRM template']);
  assert.strictEqual(result.code, undefined);

  const localDir = path.join(home, '.atris', 'templates', 'crm-starter');
  assert.strictEqual(fs.readFileSync(path.join(localDir, 'MAP.md'), 'utf8'), '# map');
  assert.strictEqual(fs.readFileSync(path.join(localDir, 'team', 'member.md'), 'utf8'), 'member body');

  const meta = JSON.parse(fs.readFileSync(path.join(localDir, 'template.json'), 'utf8'));
  assert.strictEqual(meta.name, 'CRM Starter');
  assert.strictEqual(meta.description, 'Sales CRM template');
  assert.strictEqual(meta.file_count, 2);
  assert.ok(!Number.isNaN(Date.parse(meta.published_at)), 'published_at is an ISO date');

  assert.ok(result.stdout.includes(`Local copy saved to ${localDir}`), result.stdout);
});

test('takes the name from .atris/business.json when no --name is given', async (t) => {
  const { home, workspace } = setup(t);
  writeCredentials(home);
  writeFile(workspace, 'atris/MAP.md', '# map');
  writeFile(workspace, '.atris/business.json', JSON.stringify({ name: 'Acme Bakery', slug: 'acme' }));

  const result = await runPublish([]);
  assert.strictEqual(result.code, undefined);
  assert.strictEqual(apiCalls[0].opts.body.name, 'Acme Bakery');
  assert.strictEqual(apiCalls[0].opts.body.description, '');
  assert.ok(fs.existsSync(path.join(home, '.atris', 'templates', 'acme-bakery', 'MAP.md')));
});

test('falls back to the folder name, and accepts the --name= form', async (t) => {
  const { home, workspace } = setup(t);
  writeCredentials(home);
  writeFile(workspace, 'atris/MAP.md', '# map');

  const fromFolder = await runPublish([]);
  assert.strictEqual(fromFolder.code, undefined);
  assert.strictEqual(apiCalls[0].opts.body.name, 'my-studio');

  const fromEquals = await runPublish(['--name=Launch Kit']);
  assert.strictEqual(fromEquals.code, undefined);
  assert.strictEqual(apiCalls[1].opts.body.name, 'Launch Kit');
  assert.ok(fs.existsSync(path.join(home, '.atris', 'templates', 'launch-kit', 'MAP.md')));
});

test('reports a failed publish, exits 1, and writes no local copy', async (t) => {
  const { home, workspace } = setup(t);
  writeCredentials(home);
  writeFile(workspace, 'atris/MAP.md', '# map');
  apiReply = { ok: false, status: 500, errorMessage: 'server exploded' };

  const result = await runPublish(['--name', 'Broken']);
  assert.strictEqual(result.code, 1);
  assert.match(result.stderr, /Publish failed: server exploded/);
  assert.strictEqual(apiCalls.length, 1);
  assert.ok(!fs.existsSync(path.join(home, '.atris', 'templates', 'broken')));
});
