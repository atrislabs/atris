const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { migrateLegacyTeam } = require('../lib/legacy-team-migration');
const cli = path.join(__dirname, '..', 'bin', 'atris.js');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-legacy-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'atris', 'agent_team');
  const destination = path.join(root, 'atris', 'team');
  fs.mkdirSync(path.join(source, 'alice', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'alice'), { recursive: true });
  fs.writeFileSync(path.join(source, 'alice', 'MEMBER.md'), 'original member');
  fs.writeFileSync(path.join(source, 'alice', 'logs', 'one.md'), 'original log');
  fs.writeFileSync(path.join(source, 'same.md'), 'original conflict');
  fs.writeFileSync(path.join(source, 'unique.md'), 'unique original');
  fs.writeFileSync(path.join(destination, 'alice', 'MEMBER.md'), 'existing member');
  fs.writeFileSync(path.join(destination, 'same.md'), 'existing conflict');
  fs.symlinkSync('unique.md', path.join(source, 'link.md'));
  return { root, source, destination };
}
function verifyOriginals({ source, destination }) {
  assert.equal(fs.readFileSync(path.join(source, 'alice', 'MEMBER.md'), 'utf8'), 'original member');
  assert.equal(fs.readFileSync(path.join(source, 'alice', 'logs', 'one.md'), 'utf8'), 'original log');
  assert.equal(fs.readFileSync(path.join(source, 'same.md'), 'utf8'), 'original conflict');
  assert.equal(fs.readFileSync(path.join(source, 'unique.md'), 'utf8'), 'unique original');
  assert.equal(fs.readlinkSync(path.join(source, 'link.md')), 'unique.md');
  assert.equal(fs.readFileSync(path.join(destination, 'alice', 'MEMBER.md'), 'utf8'), 'existing member');
  assert.equal(fs.readFileSync(path.join(destination, 'same.md'), 'utf8'), 'existing conflict');
}
for (const args of [['init', '--minimal', '--yes', '--no-commit'], ['update', '--yes']]) {
  test(`actual ${args[0]} retains originals and copies nested nonconflicting files`, (t) => {
    const fixture = setup(t);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ATRIS_')));
    env.ATRIS_TEST_STATE_DIR = path.join(fixture.root, 'state');
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: fixture.root, env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    verifyOriginals(fixture);
    assert.equal(fs.readFileSync(path.join(fixture.destination, 'alice', 'logs', 'one.md'), 'utf8'), 'original log');
    assert.equal(fs.readFileSync(path.join(fixture.destination, 'unique.md'), 'utf8'), 'unique original');
    assert.equal(fs.existsSync(path.join(fixture.destination, 'link.md')), false);
  });
}
test('preview has no writes and reports nested copies, conflicts and links', (t) => {
  const fixture = setup(t);
  const lines = [];
  migrateLegacyTeam(fixture.source, fixture.destination, { dryRun: true, log: (line) => lines.push(line) });
  verifyOriginals(fixture);
  assert.equal(fs.existsSync(path.join(fixture.destination, 'alice', 'logs')), false);
  assert.ok(lines.some((line) => line.includes('Would migrate alice/logs/one.md')));
  assert.ok(lines.some((line) => line.includes('Skipped alice/MEMBER.md')));
  assert.ok(lines.some((line) => line.includes('Skipped link.md')));
});
test('destination links and nested type conflicts are not followed', (t) => {
  const fixture = setup(t);
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fixture.destination, 'unique.md'));
  fs.writeFileSync(path.join(fixture.destination, 'alice', 'logs'), 'blocked directory');
  migrateLegacyTeam(fixture.source, fixture.destination, { log() {} });
  verifyOriginals(fixture);
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'alice', 'logs'), 'utf8'), 'blocked directory');
  assert.deepEqual(fs.readdirSync(outside), []);
  const otherDestination = path.join(fixture.root, 'linked-team');
  fs.symlinkSync(outside, otherDestination);
  migrateLegacyTeam(fixture.source, otherDestination, { log() {} });
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('copy errors leave every original intact', (t) => {
  const fixture = setup(t);
  const originalCopy = fs.copyFileSync;
  let calls = 0;
  fs.copyFileSync = (...args) => {
    if (calls++ === 0) return originalCopy(...args);
    const error = new Error('simulated failure'); error.code = 'EIO'; throw error;
  };
  try { assert.throws(() => migrateLegacyTeam(fixture.source, fixture.destination, { log() {} }), /simulated failure/); }
  finally { fs.copyFileSync = originalCopy; }
  verifyOriginals(fixture);
});


test('a partial staged copy is cleaned up and the next attempt can finish', (t) => {
  const fixture = setup(t);
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (src, dest) => {
    fs.writeFileSync(dest, 'partial copy');
    const error = new Error('simulated partial copy'); error.code = 'EIO'; throw error;
  };
  try { assert.throws(() => migrateLegacyTeam(fixture.source, fixture.destination, { log() {} }), /simulated partial copy/); }
  finally { fs.copyFileSync = originalCopy; }
  verifyOriginals(fixture);
  assert.equal(fs.existsSync(path.join(fixture.destination, 'alice', 'logs', 'one.md')), false);
  assert.deepEqual(fs.readdirSync(path.join(fixture.destination, 'alice', 'logs')), []);
  migrateLegacyTeam(fixture.source, fixture.destination, { log() {} });
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'alice', 'logs', 'one.md'), 'utf8'), 'original log');
  verifyOriginals(fixture);
});

test('a destination created during publication is never replaced', (t) => {
  const fixture = setup(t);
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = (src, dest) => {
    if (!injected) { injected = true; fs.writeFileSync(dest, 'concurrent destination'); }
    return originalLink(src, dest);
  };
  try { migrateLegacyTeam(fixture.source, fixture.destination, { log() {} }); }
  finally { fs.linkSync = originalLink; }
  assert.equal(fs.readFileSync(path.join(fixture.destination, 'alice', 'logs', 'one.md'), 'utf8'), 'concurrent destination');
  verifyOriginals(fixture);
});
