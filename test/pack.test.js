'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { strToU8, zipSync } = require('fflate');
const {
  assertDirEmpty,
  bundlePack,
  classifyInstallSource,
  installPack,
  isUnsafeZipEntry,
  listInstalledPacks,
  readManifestFromZipEntries,
  unzipBufferToDir,
} = require('../lib/pack-cli');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
}

function sampleManifest(overrides = {}) {
  return {
    name: 'demo-pack',
    slug: 'demo-pack',
    title: 'Demo Pack',
    description: 'A tiny pack for tests.',
    author: 'test',
    tags: ['demo'],
    version: '0.1.0',
    versions: [{ version: '0.1.0', date: '2026-07-09', notes: 'test' }],
    ...overrides,
  };
}

function writeSamplePack(dir, manifest = sampleManifest()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n', 'utf8');
  return manifest;
}

function zipPackFiles(files) {
  const entries = {};
  for (const [rel, content] of Object.entries(files)) {
    entries[rel] = typeof content === 'string' ? strToU8(content) : content;
  }
  return Buffer.from(zipSync(entries));
}

test('knownCommands includes pack', () => {
  assert.ok(knownCommands.includes('pack'));
});

test('isUnsafeZipEntry rejects zip-slip and absolute paths', () => {
  assert.equal(isUnsafeZipEntry('../etc/passwd'), true);
  assert.equal(isUnsafeZipEntry('foo/../../secret.txt'), true);
  assert.equal(isUnsafeZipEntry('/tmp/evil.txt'), true);
  assert.equal(isUnsafeZipEntry('C:/windows/evil.txt'), true);
  assert.equal(isUnsafeZipEntry('safe/readme.md'), false);
});

test('readManifestFromZipEntries requires pack.json', () => {
  assert.throws(
    () => readManifestFromZipEntries({ 'readme.md': strToU8('hi') }),
    /missing pack\.json/,
  );
});

test('install rejects zip-slip archives', () => {
  const dir = makeTempDir();
  try {
    const zipBuffer = zipPackFiles({
      'pack.json': `${JSON.stringify(sampleManifest(), null, 2)}\n`,
      '../evil.txt': 'nope',
    });
    assert.throws(
      () => unzipBufferToDir(zipBuffer, path.join(dir, 'out')),
      /unsafe zip entry rejected/,
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('install refuses non-empty target directories', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'existing.txt'), 'stay', 'utf8');
    const zipBuffer = zipPackFiles({
      'pack.json': `${JSON.stringify(sampleManifest(), null, 2)}\n`,
      'README.md': '# demo\n',
    });
    assert.throws(
      () => unzipBufferToDir(zipBuffer, target),
      /refusing to overwrite non-empty directory/,
    );
    assert.throws(() => assertDirEmpty(target), /refusing to overwrite non-empty directory/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('bundle then install round-trips a pack', async () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'demo-pack');
    const manifest = writeSamplePack(packDir);
    const bundle = bundlePack(packDir, { cwd: dir });
    assert.ok(fs.existsSync(bundle.zipPath));

    const installDir = path.join(dir, 'friend-pack');
    const zipBuffer = fs.readFileSync(bundle.zipPath);
    const installed = unzipBufferToDir(zipBuffer, installDir);
    assert.equal(installed.slug, manifest.slug);
    assert.ok(fs.existsSync(path.join(installDir, 'pack.json')));
    assert.ok(fs.existsSync(path.join(installDir, 'README.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install works from a local zip via cli', async () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'demo-pack');
    writeSamplePack(packDir);
    const bundle = bundlePack(packDir, { cwd: dir });
    const installDir = path.join(dir, 'installed');
    fs.mkdirSync(installDir, { recursive: true });

    const res = runCli(['pack', 'install', bundle.zipPath, '--dir', installDir], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /installed Demo Pack v0\.1\.0/);
    assert.match(res.stdout, /boot it: open this folder in any coding agent/);
    assert.ok(fs.existsSync(path.join(installDir, 'pack.json')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack list finds installed packs under cwd', () => {
  const dir = makeTempDir();
  try {
    writeSamplePack(path.join(dir, 'alpha-pack'));
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    writeSamplePack(path.join(dir, 'nested', 'beta-pack'), sampleManifest({
      slug: 'beta-pack',
      title: 'Beta Pack',
    }));

    const listed = listInstalledPacks(dir);
    assert.equal(listed.packs.length, 2);
    const res = runCli(['pack', 'list'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /demo-pack/);
    assert.match(res.stdout, /beta-pack/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('classifyInstallSource distinguishes slug, zip, and url', () => {
  const dir = makeTempDir();
  try {
    const zipPath = path.join(dir, 'demo.zip');
    fs.writeFileSync(zipPath, 'zip', 'utf8');
    assert.equal(classifyInstallSource('g-brain', dir).kind, 'slug');
    assert.equal(classifyInstallSource(zipPath, dir).kind, 'zip');
    assert.equal(classifyInstallSource('https://example.com/pack.zip', dir).kind, 'url');
  } finally {
    cleanupTempDir(dir);
  }
});

test('installPack uses registry url for slugs', async () => {
  const dir = makeTempDir();
  try {
    const zipBuffer = zipPackFiles({
      'pack.json': `${JSON.stringify(sampleManifest({ slug: 'g-brain', title: 'G Brain' }), null, 2)}\n`,
      'README.md': '# g brain\n',
    });
    const calls = [];
    await installPack('g-brain', {
      cwd: dir,
      deps: {
        httpRequest: async (url) => {
          calls.push(url);
          return { status: 200, body: zipBuffer };
        },
      },
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/api\/pack\/registry\/g-brain$/);
    assert.ok(fs.existsSync(path.join(dir, 'g-brain-pack', 'pack.json')));
  } finally {
    cleanupTempDir(dir);
  }
});
