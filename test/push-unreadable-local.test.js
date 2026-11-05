'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('push refuses an unreadable directory before issuing any remote deletes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-unreadable-'));
  const workspace = path.join(root, 'workspace');
  const hiddenDir = path.join(workspace, 'docs');
  const hiddenFile = path.join(hiddenDir, 'kept.md');
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const oldState = process.env.ATRIS_TEST_STATE_DIR;
  const oldToken = process.env.ATRIS_TOKEN;
  const deleted = [];
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  try {
    process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'state');
    process.env.ATRIS_TOKEN = 'temporary-test-token';
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(hiddenFile, 'keep me');
    fs.writeFileSync(path.join(workspace, 'README.md'), 'ok');
    require('../lib/manifest').saveManifest('sample', { workspace_root: workspace, files: {
      '/docs/kept.md': { hash: hash('keep me'), size: 7 }, '/README.md': { hash: hash('ok'), size: 2 },
    }});
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async (url, options = {}) => {
      if (url === '/business/') return { ok: true, data: [{ id: 'b1', workspace_id: 'w1', slug: 'sample', name: 'Sample' }] };
      if (options.method === 'DELETE') { deleted.push(url); return { ok: true, status: 200 }; }
      if (url === '/atris-sync/telemetry') return { ok: true, data: {} };
      if (url.includes('/sync?')) return { ok: true, data: { synced: 0 } };
      throw new Error(`unexpected mock request: ${url}`);
    });
    const originalReaddir = fs.readdirSync;
    const originalExists = fs.existsSync;
    t.mock.method(fs, 'readdirSync', function(dir, ...args) {
      if (String(dir) === hiddenDir) throw Object.assign(new Error('simulated inaccessible directory'), { code: 'EACCES' });
      return originalReaddir.call(fs, dir, ...args);
    });
    t.mock.method(fs, 'existsSync', function(file) {
      if (String(file) === hiddenFile) return false; // existsSync returns false for an inaccessible path.
      return originalExists.call(fs, file);
    });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.method(process.stdout, 'write', () => true);
    process.chdir(workspace);
    process.argv = [process.execPath, 'atris', 'push', 'sample', '--from', workspace, '--force', '--delete', '--yes'];
    const { pushAtris } = require('../commands/push');
    await assert.rejects(pushAtris(), /cannot safely scan/i);
    assert.deepEqual(deleted, []);
  } finally {
    t.mock.restoreAll();
    process.chdir(originalCwd);
    process.argv = originalArgv;
    if (oldState === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = oldState;
    if (oldToken === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = oldToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dangling local links are not planned as cloud deletions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-dangling-'));
  try {
    const { localPathExistsOrIsLinked, buildPushChangePlan } = require('../commands/push');
    fs.symlinkSync('missing-file', path.join(root, 'note.md'));
    fs.symlinkSync('missing-dir', path.join(root, 'docs'));
    const plan = buildPushChangePlan({
      localFiles: {},
      baseFiles: { '/note.md': { hash: 'a' }, '/docs/kept.md': { hash: 'b' }, '/truly-missing.md': { hash: 'c' } },
      isLocalFilePresent: (p) => localPathExistsOrIsLinked(root, p),
    });
    assert.deepEqual(plan.deletedPaths, ['/truly-missing.md']);
    const original = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (p, ...args) => {
      if (p === path.join(root, 'blocked')) throw Object.assign(new Error('inaccessible'), { code: 'EACCES' });
      return original.call(fs, p, ...args);
    });
    assert.throws(() => localPathExistsOrIsLinked(root, '/blocked/file.md'), /cannot safely inspect/i);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
