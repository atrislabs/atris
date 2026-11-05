'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const cli = path.join(repo, 'bin/atris.js');

function fixture(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-exclusive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'workspace');
  fs.mkdirSync(output);
  if (scenario === 'restore') fs.writeFileSync(path.join(output, 'anchor.md'), 'local anchor');
  const dest = path.join(output, 'notes.md');
  const preload = path.join(root, 'mock.cjs');
  fs.writeFileSync(preload, `
    const path = require('node:path');
    const fs = require('node:fs');
    const repo = process.env.PULL_EXCLUSIVE_REPO;
    const auth = require(path.join(repo, 'utils/auth')); auth.ensureFreshCredentials = async () => ({ token: 'dummy' });
    const business = require(path.join(repo, 'commands/business')); business.loadBusinesses = () => ({}); business.saveBusinesses = () => {};
    const manifest = require(path.join(repo, 'lib/manifest'));
    manifest.loadManifest = () => process.env.PULL_EXCLUSIVE_SCENARIO === 'restore' ? {files: {'/notes.md': {hash:'prior-hash'}}, workspace_root: process.env.PULL_EXCLUSIVE_OUTPUT} : null;
    manifest.saveManifest = () => {};
    const compare = manifest.threeWayCompare;
    manifest.threeWayCompare = (...args) => {
      const diff = compare(...args);
      if (process.env.PULL_EXCLUSIVE_SCENARIO === 'restore') fs.writeFileSync(process.env.PULL_EXCLUSIVE_CLASS, JSON.stringify(diff.deletedLocal));
      return diff;
    };
    const telemetry = require(path.join(repo, 'lib/sync-telemetry')); telemetry.emitSyncEvent = () => {};
    const api = require(path.join(repo, 'utils/api')); api.apiRequestJson = async url => {
      if (url === '/business/') return {ok:true,data:[{id:'business-1',workspace_id:'workspace-1',slug:'sample',name:'Sample'}]};
      if (url.includes('/snapshot?')) return {ok:true,data:{files:[{path:'/notes.md',content:'cloud content'}]}};
      if (url.endsWith('/git/head')) return {ok:true,data:{commit:null}};
      throw new Error('unexpected mocked route ' + url);
    };
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function(file, data, ...args) {
      if (process.env.PULL_EXCLUSIVE_SCENARIO !== 'fresh' && String(file) === process.env.PULL_EXCLUSIVE_DEST) {
        const code = process.env.PULL_EXCLUSIVE_SCENARIO === 'directory'
          ? 'require("node:fs").mkdirSync(process.argv[1])'
          : process.env.PULL_EXCLUSIVE_SCENARIO === 'symlink'
          ? 'require("node:fs").symlinkSync(process.argv[2], process.argv[1])'
          : 'require("node:fs").writeFileSync(process.argv[1], "concurrent local edit")';
        const child = require('node:child_process').spawnSync(process.execPath, ['-e', code, String(file), process.env.PULL_EXCLUSIVE_TARGET], {env:{...process.env,NODE_OPTIONS:''},encoding:'utf8'});
        if (child.status !== 0) throw new Error('fixture writer failed: ' + child.stderr);
        originalWrite.call(fs, process.env.PULL_EXCLUSIVE_MARKER, 'writer succeeded');
      }
      return originalWrite.call(this, file, data, ...args);
    };
  `);
  const target = path.join(root, 'outside.txt');
  fs.writeFileSync(target, 'existing target');
  const result = spawnSync(process.execPath, ['--require', preload, cli, 'pull', 'sample', '--into', output, '--no-manifest', '--keep-local'], {
    cwd: root, encoding: 'utf8', env: {...process.env, ATRIS_SKIP_UPDATE_CHECK:'1', PULL_EXCLUSIVE_REPO:repo, PULL_EXCLUSIVE_SCENARIO:scenario, PULL_EXCLUSIVE_OUTPUT:output, PULL_EXCLUSIVE_DEST:dest, PULL_EXCLUSIVE_TARGET:target, PULL_EXCLUSIVE_MARKER:path.join(root,'marker'), PULL_EXCLUSIVE_CLASS:path.join(root,'classification')}, timeout:10000,
  });
  return {root, dest, target, result};
}

for (const scenario of ['new', 'restore', 'symlink', 'directory']) {
  test(`keep-local preserves a ${scenario} destination created after preflight`, t => {
    const {root, dest, target, result} = fixture(t, scenario);
    assert.equal(fs.readFileSync(path.join(root,'marker'),'utf8'), 'writer succeeded');
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    if (scenario === 'restore') assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'classification'), 'utf8')), ['/notes.md']);
    if (scenario === 'directory') assert.equal(fs.lstatSync(dest).isDirectory(), true);
    else if (scenario === 'symlink') {
      assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(target,'utf8'), 'existing target');
    } else assert.equal(fs.readFileSync(dest,'utf8'), 'concurrent local edit');
  });
}

test('keep-local creates an uncontended new file', t => {
  const {dest, result} = fixture(t, 'fresh');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(dest,'utf8'), 'cloud content');
});
