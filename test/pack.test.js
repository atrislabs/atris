const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readZipFile, writeZipFile } = require('../lib/zip');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedAtris(dir) {
  const atrisDir = path.join(dir, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'atris.md'), '# Atris\n');
  return atrisDir;
}

function runCli(args, { cwd }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('pack publish --out then install round trips atris and manifest', () => {
  const dir = makeTempDir();
  try {
    seedAtris(dir);
    const zipPath = path.join(dir, 'demo.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'demo-pack', '--notes', 'first publish', '--out', zipPath], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);

    const target = path.join(dir, 'installed');
    const install = runCli(['pack', 'install', zipPath, '--dir', target], { cwd: dir });
    assert.equal(install.status, 0, `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`);
    assert.ok(fs.existsSync(path.join(target, 'atris', 'atris.md')));
    assert.ok(fs.existsSync(path.join(target, 'pack.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8'));
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.slug, 'demo-pack');
    assert.match(install.stdout, /cd .* && claude/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish excludes credentials, env files, state, git, and logs by default', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = seedAtris(dir);
    fs.writeFileSync(path.join(atrisDir, 'credentials.json'), '{}\n');
    fs.writeFileSync(path.join(atrisDir, '.env'), 'secret=1\n');
    fs.writeFileSync(path.join(atrisDir, 'server.pem'), 'secret\n');
    fs.writeFileSync(path.join(atrisDir, 'deploy.key'), 'secret\n');
    fs.writeFileSync(path.join(atrisDir, 'id_rsa_test'), 'secret\n');
    fs.mkdirSync(path.join(atrisDir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(atrisDir, '.atris', 'state', 'cache.json'), '{}\n');
    fs.mkdirSync(path.join(atrisDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(atrisDir, '.git', 'config'), '[core]\n');
    fs.mkdirSync(path.join(atrisDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'logs', '2026-07-09.md'), 'log\n');

    const zipPath = path.join(dir, 'demo.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'safe-pack', '--out', zipPath], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);

    const names = readZipFile(zipPath).map((entry) => entry.name);
    assert.ok(names.includes('pack.json'));
    assert.ok(names.includes('atris/atris.md'));
    assert.ok(!names.includes('atris/credentials.json'));
    assert.ok(!names.includes('atris/.env'));
    assert.ok(!names.includes('atris/server.pem'));
    assert.ok(!names.includes('atris/deploy.key'));
    assert.ok(!names.includes('atris/id_rsa_test'));
    assert.ok(!names.some((name) => name.startsWith('atris/.atris/state/')));
    assert.ok(!names.some((name) => name.startsWith('atris/.git/')));
    assert.ok(!names.some((name) => name.startsWith('atris/logs/')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install refuses zip entries that escape the target dir', () => {
  const dir = makeTempDir();
  try {
    const zipPath = path.join(dir, 'evil.zip');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(JSON.stringify({ slug: 'evil-pack' })) },
      { name: '../evil.txt', data: Buffer.from('owned\n') },
    ]);

    const target = path.join(dir, 'target');
    const install = runCli(['pack', 'install', zipPath, '--dir', target], { cwd: dir });
    assert.notEqual(install.status, 0, `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`);
    assert.match(`${install.stdout}\n${install.stderr}`, /refusing zip entry outside target/);
    assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
    assert.ok(!fs.existsSync(target));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish bumps patch version on subsequent publish', () => {
  const dir = makeTempDir();
  try {
    seedAtris(dir);
    const firstZip = path.join(dir, 'first.zip');
    const secondZip = path.join(dir, 'second.zip');
    const first = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'version-pack', '--out', firstZip], { cwd: dir });
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    const second = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'version-pack', '--out', secondZip], { cwd: dir });
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.equal(manifest.version, '0.1.1');
    assert.deepEqual(manifest.versions.map((entry) => entry.version), ['0.1.0', '0.1.1']);
    const zipManifest = JSON.parse(readZipFile(secondZip).find((entry) => entry.name === 'pack.json').data.toString('utf8'));
    assert.equal(zipManifest.version, '0.1.1');
  } finally {
    cleanupTempDir(dir);
  }
});
