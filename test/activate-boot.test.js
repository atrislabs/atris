const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { driftCount, readBusinessSlug, syncStatus } = require('../lib/sync-status');
const { buildManifest, saveManifest, computeLocalHashes } = require('../lib/manifest');
const { activateAtris } = require('../commands/activate');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- driftCount: pure logic ---

test('driftCount: identical local and manifest → 0', () => {
  const files = { '/a.md': { hash: 'x' }, '/b.md': { hash: 'y' } };
  assert.strictEqual(driftCount(files, { files }), 0);
});

test('driftCount: changed + new + deleted each count once', () => {
  const local = { '/a.md': { hash: 'x2' }, '/c.md': { hash: 'z' } };
  const manifest = { files: { '/a.md': { hash: 'x' }, '/b.md': { hash: 'y' } } };
  // a changed, b deleted locally, c new locally => 3 drifted
  assert.strictEqual(driftCount(local, manifest), 3);
});

test('driftCount: null manifest treats all local as drift', () => {
  assert.strictEqual(driftCount({ '/a.md': { hash: 'x' } }, null), 1);
});

// --- readBusinessSlug / offline paths ---

test('syncStatus: no business.json → offline', () => {
  const root = mkTmp('atris-boot-off-');
  try {
    assert.strictEqual(readBusinessSlug(root), null);
    assert.strictEqual(syncStatus(root), 'offline');
  } finally {
    cleanup(root);
  }
});

test('syncStatus: business but no manifest → offline', () => {
  const root = mkTmp('atris-boot-nomanifest-');
  const home = mkTmp('atris-boot-home-');
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ slug: 'acme' }));
    assert.strictEqual(syncStatus(root), 'offline');
  } finally {
    process.env.HOME = prevHome;
    cleanup(root);
    cleanup(home);
  }
});

// --- in sync / drifted against a saved manifest ---

test('syncStatus: manifest matches local → in sync; edit → drifted', () => {
  const root = mkTmp('atris-boot-sync-');
  const home = mkTmp('atris-boot-home2-');
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ slug: 'acme' }));
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'one.md'), 'hello\n');
    fs.writeFileSync(path.join(root, 'atris', 'two.md'), 'world\n');

    saveManifest('acme', buildManifest(computeLocalHashes(root), null));
    assert.strictEqual(syncStatus(root), 'in sync');

    fs.writeFileSync(path.join(root, 'atris', 'one.md'), 'changed\n');
    assert.strictEqual(syncStatus(root), '1 file drifted');

    fs.writeFileSync(path.join(root, 'atris', 'three.md'), 'new\n');
    assert.strictEqual(syncStatus(root), '2 files drifted');
  } finally {
    process.env.HOME = prevHome;
    cleanup(root);
    cleanup(home);
  }
});

// --- integration: activate boot output is a short narration ---

test('activateAtris output narrates the current workspace without boot internals', () => {
  const root = mkTmp('atris-boot-activate-');
  const prevCwd = process.cwd();
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'PERSONA.md'), '# persona\n');
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\n');
    process.chdir(root);
    activateAtris();
    const out = logs.join('\n');
    assert.strictEqual(logs[0], 'atris is up.');
    assert.match(out, /^right now: /m);
    assert.match(out, /^nothing is waiting on you\.$/m);
    assert.doesNotMatch(out, /zero approvals/);
    assert.doesNotMatch(out, /atris brief:|^sync:/m);
  } finally {
    console.log = origLog;
    process.chdir(prevCwd);
    cleanup(root);
  }
});
