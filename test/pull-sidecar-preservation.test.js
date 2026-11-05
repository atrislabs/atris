'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const scenario of ['existing later sidecar', 'remote path collision', 'concurrent sidecar', 'new sidecar']) {
  test(`keep-local preserves conflict sidecars: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pull-sidecar-'));
    const output = path.join(root, 'workspace');
    const priorCwd = process.cwd();
    const priorArgv = process.argv;
    const priorState = process.env.ATRIS_TEST_STATE_DIR;
    const priorToken = process.env.ATRIS_TOKEN;
    const priorWrite = fs.writeFileSync;
    const api = require('../utils/api');
    const priorRequest = api.apiRequestJson;
    const sidecar = path.join(output, 'second.md.remote');
    try {
      process.env.ATRIS_TEST_STATE_DIR = path.join(root, 'test-state');
      process.env.ATRIS_TOKEN = 'test-token';
      process.chdir(root);
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(output, 'first.md'), 'first local');
      fs.writeFileSync(path.join(output, 'second.md'), 'second local');
      if (scenario === 'existing later sidecar') fs.writeFileSync(sidecar, 'private sidecar');
      const files = [
        { path: '/first.md', content: 'first remote' },
        { path: '/second.md', content: 'second remote' },
        { path: '/new.md', content: 'new remote' },
      ];
      if (scenario === 'remote path collision') files.push({ path: '/second.md.remote', content: 'remote names the sidecar' });
      api.apiRequestJson = async (url) => {
        if (url === '/business/') return { ok: true, data: [{ id: 'business-1', workspace_id: 'workspace-1', slug: 'sample', name: 'Sample' }] };
        if (url === '/business/business-1/workspaces/workspace-1/snapshot?include_content=true') return { ok: true, data: { files } };
        if (url.endsWith('/git/head')) return { ok: true, data: { commit: null } };
        if (url === '/atris-sync/telemetry') return { ok: true, data: {} };
        throw new Error(`unexpected request ${url}`);
      };
      process.argv = [process.execPath, 'atris', 'pull', 'sample', '--into', output, '--no-manifest', '--keep-local'];
      if (scenario === 'concurrent sidecar') {
        fs.writeFileSync = function(file, data, options) {
          if (file === sidecar && options?.flag === 'wx') priorWrite.call(fs, sidecar, 'concurrent sidecar');
          return priorWrite.call(fs, file, data, options);
        };
      }
      delete require.cache[require.resolve('../commands/pull')];
      const pull = require('../commands/pull').pullAtris();
      if (scenario === 'new sidecar') {
        await pull;
        assert.equal(fs.readFileSync(sidecar, 'utf8'), 'second remote');
        assert.equal(fs.readFileSync(path.join(output, 'first.md.remote'), 'utf8'), 'first remote');
      } else {
        await assert.rejects(pull, scenario === 'concurrent sidecar' ? /EEXIST/ : /conflict sidecar/);
        assert.equal(fs.readFileSync(path.join(output, 'first.md'), 'utf8'), 'first local');
        assert.equal(fs.readFileSync(path.join(output, 'second.md'), 'utf8'), 'second local');
        if (scenario !== 'concurrent sidecar') {
          assert.equal(fs.existsSync(path.join(output, 'first.md.remote')), false);
          assert.equal(fs.existsSync(path.join(output, 'new.md')), false);
        }
        if (scenario === 'existing later sidecar') assert.equal(fs.readFileSync(sidecar, 'utf8'), 'private sidecar');
        if (scenario === 'concurrent sidecar') assert.equal(fs.readFileSync(sidecar, 'utf8'), 'concurrent sidecar');
      }
    } finally {
      fs.writeFileSync = priorWrite;
      api.apiRequestJson = priorRequest;
      process.chdir(priorCwd);
      process.argv = priorArgv;
      if (priorState === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = priorState;
      if (priorToken === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = priorToken;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
