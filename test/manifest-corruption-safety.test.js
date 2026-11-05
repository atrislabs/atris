'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadManifest } = require('../lib/manifest');

test('an absent manifest remains a first sync, but a broken manifest is not absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-broken-'));
  const prior = process.env.ATRIS_TEST_STATE_DIR;
  process.env.ATRIS_TEST_STATE_DIR = root;
  try {
    assert.equal(loadManifest('sample'), null);
    const file = path.join(root, '.atris/businesses/sample/manifest.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"files":');
    assert.throws(() => loadManifest('sample'), /manifest/i);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"files":');
    for (const invalid of ['null', '[]', '{"files":null}', '{"files":[]}', '{"files":{"/notes.md":{}}}', '{"files":{"/notes.md":{"hash":""}}}']) {
      fs.writeFileSync(file, invalid);
      assert.throws(() => loadManifest('sample'), /manifest/i);
    }
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(root, 'missing-target'), file);
    assert.throws(() => loadManifest('sample'), /cannot safely inspect sync manifest/);
  } finally {
    if (prior === undefined) delete process.env.ATRIS_TEST_STATE_DIR;
    else process.env.ATRIS_TEST_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dangling state ancestor is not treated as a missing baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-dangling-parent-'));
  const prior = process.env.ATRIS_TEST_STATE_DIR;
  process.env.ATRIS_TEST_STATE_DIR = root;
  try {
    fs.symlinkSync(path.join(root, 'missing-state'), path.join(root, '.atris'));
    assert.throws(() => loadManifest('sample'), /cannot safely inspect sync manifest/);
  } finally {
    if (prior === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable existing manifest is not treated as a first sync', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-read-error-'));
  const prior = process.env.ATRIS_TEST_STATE_DIR;
  const savedRead = fs.readFileSync;
  process.env.ATRIS_TEST_STATE_DIR = root;
  const file = path.join(root, '.atris/businesses/sample/manifest.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"files":{}}');
    fs.readFileSync = function(target, ...args) {
      if (target === file) throw Object.assign(new Error('simulated read failure'), { code: 'EIO' });
      return savedRead.call(fs, target, ...args);
    };
    assert.throws(() => loadManifest('sample'), /cannot safely read sync manifest/);
    fs.readFileSync = savedRead;
    assert.equal(fs.readFileSync(file, 'utf8'), '{"files":{}}');
  } finally {
    fs.readFileSync = savedRead;
    if (prior === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('boot sync status reports an unavailable baseline without blocking', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-boot-'));
  const prior = process.env.ATRIS_TEST_STATE_DIR;
  process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'state');
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.atris/business.json'), '{"slug":"sample"}');
    const file = path.join(root, 'state/.atris/businesses/sample/manifest.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"files":');
    assert.equal(require('../lib/sync-status').syncStatus(workspace), 'sync state unavailable');
  } finally {
    if (prior === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keep-local pull preserves local files and broken manifest when baseline cannot be parsed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-pull-'));
  const prevState = process.env.ATRIS_TEST_STATE_DIR;
  const prevToken = process.env.ATRIS_TOKEN;
  const cwd = process.cwd();
  const argv = process.argv;
  const log = console.log;
  const err = console.error;
  const write = process.stdout.write;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  try {
    process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'state');
    process.env.ATRIS_TOKEN = 'test-token';
    const output = path.join(root, 'workspace');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'notes.md'), 'local data');
    const baseline = path.join(root, 'state/.atris/businesses/sample/manifest.json');
    fs.mkdirSync(path.dirname(baseline), { recursive: true });
    fs.writeFileSync(baseline, '{"files":');
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'pull', 'sample', '--into', output, '--keep-local'];
    console.log = () => {};
    console.error = () => {};
    process.stdout.write = () => true;
    api.apiRequestJson = async url => {
      if (url === '/business/') return { ok: true, data: [{ id: 'business-1', workspace_id: 'workspace-1', slug: 'sample', name: 'Sample' }] };
      if (url.includes('/snapshot?')) return { ok: true, data: { files: [{ path: '/notes.md', content: 'cloud data' }] } };
      if (url.endsWith('/git/head')) return { ok: true, data: { commit: null } };
      if (url === '/atris-sync/telemetry') return { ok: true, data: {} };
      throw new Error(`unexpected request ${url}`);
    };
    const { pullAtris } = require('../commands/pull');
    await assert.rejects(pullAtris(), /manifest/i);
    assert.equal(fs.readFileSync(path.join(output, 'notes.md'), 'utf8'), 'local data');
    assert.equal(fs.readFileSync(baseline, 'utf8'), '{"files":');
  } finally {
    api.apiRequestJson = request;
    process.chdir(cwd); process.argv = argv; console.log = log; console.error = err; process.stdout.write = write;
    if (prevState === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = prevState;
    if (prevToken === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = prevToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('push refuses a broken manifest before uploads or deletes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-push-'));
  const prevState = process.env.ATRIS_TEST_STATE_DIR;
  const prevToken = process.env.ATRIS_TOKEN;
  const cwd = process.cwd();
  const argv = process.argv;
  try {
    process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'state');
    process.env.ATRIS_TOKEN = 'temporary-test-token';
    const output = path.join(root, 'workspace');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'notes.md'), 'local data');
    const baseline = path.join(root, 'state/.atris/businesses/sample/manifest.json');
    fs.mkdirSync(path.dirname(baseline), { recursive: true });
    fs.writeFileSync(baseline, '{"files":');
    let writes = 0;
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async (url, options = {}) => {
      if (url === '/business/') return { ok: true, data: [{ id: 'business-1', workspace_id: 'workspace-1', slug: 'sample', name: 'Sample' }] };
      if (options.method === 'POST' || options.method === 'DELETE') { writes++; return { ok: true, data: {} }; }
      throw new Error(`unexpected request ${url}`);
    });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.method(process.stdout, 'write', () => true);
    process.chdir(output);
    process.argv = [process.execPath, 'atris', 'push', 'sample', '--from', output, '--force', '--delete', '--yes'];
    const { pushAtris } = require('../commands/push');
    await assert.rejects(pushAtris(), /cannot safely parse sync manifest/);
    assert.equal(writes, 0);
    assert.equal(fs.readFileSync(path.join(output, 'notes.md'), 'utf8'), 'local data');
    assert.equal(fs.readFileSync(baseline, 'utf8'), '{"files":');
  } finally {
    t.mock.restoreAll(); process.chdir(cwd); process.argv = argv;
    if (prevState === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = prevState;
    if (prevToken === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = prevToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
