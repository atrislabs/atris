const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { appsCommand } = require('../commands/apps');

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function makeTempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makePack(t) {
  const root = makeTempDir(t, 'atris-apps-pack-');
  const pack = path.join(root, 'atris', 'apps-pack');
  const app = path.join(pack, 'apps', 'demo-app');
  fs.mkdirSync(path.join(pack, 'scripts'), { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(pack, 'scripts', 'app_use.py'), '# test\n');
  fs.writeFileSync(path.join(app, 'APP.md'), `---
schema_version: 1
name: Demo App
slug: demo-app
description: Demo metadata.
runtime: local
secrets: []
surfaces:
  - cli
---

# Demo App
`);
  return { root, pack };
}

function setEnv(t, name, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (had) process.env[name] = old;
    else delete process.env[name];
  });
}

async function runCaptured(t, fn) {
  const captured = { stdout: '', stderr: '', code: null };
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...args) => { captured.stdout += args.join(' ') + '\n'; };
  console.error = (...args) => { captured.stderr += args.join(' ') + '\n'; };
  process.exit = (code = 0) => { captured.code = code; throw new ExitSignal(code); };
  t.after(() => {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  });
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return captured;
}

test('appsCommand help prints usage and returns without exiting', async (t) => {
  const res = await runCaptured(t, () => appsCommand('help'));
  assert.equal(res.code, null);
  assert.match(res.stdout, /Usage: atris apps <command>/);
  assert.match(res.stdout, /list \[--json\]/);
  assert.match(res.stdout, /run <slug>/);
  assert.equal(res.stderr, '');
});

test('appsCommand list --json prints pack root and app manifests', async (t) => {
  const { pack } = makePack(t);
  setEnv(t, 'ATRIS_APPS_PACK', pack);
  const res = await runCaptured(t, () => appsCommand('list', '--json'));
  assert.equal(res.code, 0);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.pack, pack);
  assert.equal(payload.apps.length, 1);
  assert.equal(payload.apps[0].slug, 'demo-app');
  assert.equal(payload.apps[0].name, 'Demo App');
  assert.equal(payload.apps[0].schema_version, 1);
  assert.deepEqual(payload.apps[0].surfaces, ['cli']);
});

test('appsCommand --json alone normalizes to list --json', async (t) => {
  const { pack } = makePack(t);
  setEnv(t, 'ATRIS_APPS_PACK', pack);
  const res = await runCaptured(t, () => appsCommand('--json'));
  assert.equal(res.code, 0);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.pack, pack);
  assert.equal(payload.apps.length, 1);
  assert.equal(payload.apps[0].slug, 'demo-app');
});

test('appsCommand without a pack prints a JSON error and exits 1', async (t) => {
  const empty = makeTempDir(t, 'atris-apps-empty-');
  setEnv(t, 'ATRIS_APPS_PACK', undefined);
  const cwd = process.cwd();
  process.chdir(empty);
  t.after(() => process.chdir(cwd));
  const res = await runCaptured(t, () => appsCommand('list', '--json'));
  assert.equal(res.code, 1);
  assert.equal(res.stderr, '');
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'No Atris app pack found.');
  assert.equal(payload.expected, 'atris/apps-pack/ in this workspace, or ATRIS_APPS_PACK');
});

test('appsCommand unknown subcommand returns a usage error payload', async (t) => {
  const { pack } = makePack(t);
  setEnv(t, 'ATRIS_APPS_PACK', pack);
  const res = await runCaptured(t, () => appsCommand('nope', '--json'));
  assert.equal(res.code, 1);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'Unknown apps command: nope');
  assert.ok(Array.isArray(payload.usage));
  assert.ok(payload.usage.some((line) => line.includes('atris apps <command>')));
});

test('appsCommand run without a slug writes usage error to stderr', async (t) => {
  const { pack } = makePack(t);
  setEnv(t, 'ATRIS_APPS_PACK', pack);
  const res = await runCaptured(t, () => appsCommand('run'));
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Usage: atris apps run <slug>/);
});
