'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

test('actual push stops before writes when a changed file becomes unreadable after hash scan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-late-read-'));
  const work = path.join(root, 'workspace');
  const saved = {cwd: process.cwd(), argv: process.argv, state: process.env.ATRIS_TEST_STATE_DIR, token: process.env.ATRIS_TOKEN};
  const writes = [], logs = [];
  try {
    process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'state');
    process.env.ATRIS_TOKEN = 'dummy';
    fs.mkdirSync(work, {recursive: true});
    const target = path.join(work, 'changed.txt');
    fs.writeFileSync(target, 'new local text');
    require('../lib/manifest').saveManifest('sample', {workspace_root: work, files: {'/changed.txt': {hash: 'old-hash', size: 3}, '/missing.txt': {hash: 'old-hash', size: 3}}});
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async (url, opts = {}) => {
      if (url === '/business/') return {ok: true, data: [{id: 'business', workspace_id: 'workspace', slug: 'sample', name: 'Sample'}]};
      if (url === '/atris-sync/telemetry') return {ok: true, data: {}};
      if (opts.method === 'POST' || opts.method === 'DELETE') { writes.push(url); return {ok: true, data: {}}; }
      throw new Error(`unexpected request: ${url}`);
    });
    let reads = 0;
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function(p, ...args) {
      if (String(p) === target && ++reads >= 2) throw Object.assign(new Error('synthetic late read error'), {code:'EIO'});
      return original.call(fs, p, ...args);
    });
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    t.mock.method(console, 'error', () => {});
    t.mock.method(process.stdout, 'write', () => true);
    process.chdir(work);
    process.argv = [process.execPath, 'atris', 'push', 'sample', '--from', work, '--force', '--delete', '--delete-all', '--yes'];
    delete require.cache[require.resolve('../commands/push')];
    await assert.rejects(require('../commands/push').pushAtris(), /cannot safely read local workspace/);
    assert.ok(reads >= 2);
    assert.deepEqual(writes, []);
    assert.ok(!logs.some(line => line.includes('Already up to date')));
  } finally {
    t.mock.restoreAll(); process.chdir(saved.cwd); process.argv = saved.argv;
    if (saved.state === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = saved.state;
    if (saved.token === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = saved.token;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
