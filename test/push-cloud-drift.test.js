const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runPush({ force = true, cloud = 'reverted', snapshotOk = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-push-cloud-'));
  try {
    fs.writeFileSync(path.join(dir, 'note.md'), 'local content');
    const script = `
      const root = ${JSON.stringify(path.resolve(__dirname, '..'))};
      const load = (name) => require(root + '/' + name);
      const auth = load('utils/auth');
      auth.loadCredentials = () => ({ token: 'test' });
      const business = load('commands/business');
      business.loadBusinesses = () => ({});
      business.saveBusinesses = () => {};
      const manifest = load('lib/manifest');
      const hash = manifest.computeFileHash('local content');
      manifest.loadManifest = () => ({ files: { '/note.md': { hash } } });
      manifest.saveManifest = () => {};
      load('lib/sync-telemetry').emitSyncEvent = async () => {};
      let snapshots = 0;
      const uploads = [];
      load('utils/api').apiRequestJson = async (url, options) => {
        if (url === '/business/') return { ok: true, data: [{ id: 'biz', workspace_id: 'ws', slug: 'example-co', name: 'example' }] };
        if (url.includes('/snapshot?include_content=false')) {
          snapshots++;
          return { ok: ${snapshotOk}, status: ${snapshotOk ? 200 : 503}, data: { files: ${cloud === 'missing' ? '[]' : `[{ path: 'note.md', hash: ${cloud === 'same' ? 'hash' : "'cloud-reverted-hash'"} }]`} } };
        }
        if (url.includes('/sync?')) {
          uploads.push(...options.body.files);
          return { ok: true, data: { results: options.body.files.map(f => ({ path: f.path, status: 'written' })) } };
        }
        throw new Error('unexpected request: ' + url);
      };
      process.argv = ['node', 'atris', 'push', 'example-co', '--from', ${JSON.stringify(dir)}, '--only', 'note.md', '--yes', ${force ? "'--force'" : "'--no-force'"}];
      load('commands/push').pushAtris().then(() => {
        console.log('RESULT:' + JSON.stringify({ snapshots, uploads }));
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    return spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const cloud of ['reverted', 'missing']) {
  test(`forced push repairs ${cloud} cloud file even when manifest matches local`, () => {
    const result = runPush({ cloud });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(result.stdout.split('RESULT:')[1]);
    assert.deepEqual(data.uploads, [{ path: 'note.md', content: 'local content' }]);
    assert.equal(data.snapshots, 1);
    assert.doesNotMatch(result.stdout, /Already up to date/);
  });
}

test('forced push skips a file already matching current cloud', () => {
  const result = runPush({ cloud: 'same' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(result.stdout.split('RESULT:')[1]);
  assert.equal(data.snapshots, 1);
  assert.deepEqual(data.uploads, []);
});

test('forced push uploads conservatively when current cloud hashes are unavailable', () => {
  const result = runPush({ snapshotOk: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(result.stdout.split('RESULT:')[1]);
  assert.deepEqual(data.uploads, [{ path: 'note.md', content: 'local content' }]);
});

test('ordinary push still refuses cloud drift', () => {
  const result = runPush({ force: false });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Files that differ on cloud/);
  assert.doesNotMatch(result.stdout, /RESULT:/);
});

test('ordinary push still refuses an unavailable snapshot', () => {
  const result = runPush({ force: false, snapshotOk: false });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Could not verify cloud freshness/);
});

test('current cloud hashes do not expand manifest-based deletion planning', () => {
  const { buildPushChangePlan } = require('../commands/push');
  const plan = buildPushChangePlan({
    localFiles: { '/note.md': { hash: 'local' } },
    baseFiles: { '/note.md': { hash: 'local' }, '/removed.md': { hash: 'old' } },
    cloudHashes: { '/note.md': 'reverted', '/cloud-only.md': 'remote' },
    readFileContent: () => 'local content',
  });
  assert.deepEqual(plan.deletedPaths, ['/removed.md']);
  assert.deepEqual(plan.filesToPush, [{ path: '/note.md', content: 'local content' }]);
});
