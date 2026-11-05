'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

for (const mode of ['apply', 'dry-run']) {
  test(`actual push ${mode} preserves a file created after its missing-path check`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-paused-'));
    const work = path.join(root, 'workspace');
    const saved = { cwd: process.cwd(), argv: process.argv, state: process.env.ATRIS_TEST_STATE_DIR, token: process.env.ATRIS_TOKEN };
    const writes = [], logs = [];
    try {
      process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'state');
      process.env.ATRIS_TOKEN = 'dummy';
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(work, 'changed.txt'), 'new value');
      const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
      const manifest = require('../lib/manifest');
      manifest.saveManifest('sample', { workspace_root: work, files: {
        '/missing.txt': { hash: hash('old'), size: 3 },
        '/changed.txt': { hash: hash('previous'), size: 8 },
      } });
      const manifestBefore = JSON.stringify(manifest.loadManifest('sample'));
      const api = require('../utils/api');
      t.mock.method(api, 'apiRequestJson', async (url, opts = {}) => {
        if (url === '/business/') return { ok: true, data: [{ id: 'business', workspace_id: 'workspace', slug: 'sample', name: 'Sample' }] };
        if (url === '/atris-sync/telemetry') return { ok: true, data: {} };
        if (opts.method === 'POST' || opts.method === 'DELETE') { writes.push({ url, method: opts.method }); return { ok: true, data: {} }; }
        throw new Error(`unexpected mock request: ${url}`);
      });
      const original = fs.lstatSync;
      let injected = false;
      const missing = path.join(work, 'missing.txt');
      t.mock.method(fs, 'lstatSync', function(p, ...args) {
        if (!injected && String(p) === missing) {
          injected = true;
          execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "new local")', missing]);
          throw Object.assign(new Error('observed missing'), { code: 'ENOENT' });
        }
        return original.call(fs, p, ...args);
      });
      t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
      t.mock.method(console, 'error', () => {});
      t.mock.method(process.stdout, 'write', () => true);
      process.chdir(work);
      process.argv = [process.execPath, 'atris', 'push', 'sample', '--from', work, '--force', '--delete', '--delete-all', '--yes'];
      if (mode === 'dry-run') process.argv.push('--dry-run');
      delete require.cache[require.resolve('../commands/push')];
      const task = require('../commands/push').pushAtris();
      if (mode === 'apply') await assert.rejects(task, /cloud deletion is unavailable/i);
      else await task;
      assert.ok(injected);
      assert.equal(fs.readFileSync(missing, 'utf8'), 'new local');
      assert.deepEqual(writes, []);
      assert.equal(JSON.stringify(manifest.loadManifest('sample')), manifestBefore);
      if (mode === 'dry-run') assert.ok(logs.some((line) => line.includes('not a safe deletion list')));
    } finally {
      t.mock.restoreAll(); process.chdir(saved.cwd); process.argv = saved.argv;
      if (saved.state === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = saved.state;
      if (saved.token === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = saved.token;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
