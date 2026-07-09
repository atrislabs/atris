const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readZipFile, writeZipFile } = require('../lib/zip');
const { comparePackVersions, installPack, listInstalledPacks, pullPack, updatePack } = require('../commands/pack');

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

function sampleManifest(overrides = {}) {
  return {
    name: 'demo-pack',
    slug: 'demo-pack',
    title: 'Demo Pack',
    description: 'A tiny pack for tests.',
    version: '0.1.0',
    ...overrides,
  };
}

function writePackDir(dir, overrides = {}) {
  const manifest = sampleManifest(overrides);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# pack\n', 'utf8');
  return manifest;
}

function packZipBuffer(dir, manifest = sampleManifest()) {
  const zipPath = path.join(dir, `${manifest.slug}.zip`);
  writeZipFile(zipPath, [
    { name: 'pack.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'README.md', data: Buffer.from('# pack\n') },
  ]);
  return fs.readFileSync(zipPath);
}

function runCli(args, { cwd, env = {} }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

test('pack publish without output still writes pack.json and sharing hint', () => {
  const dir = makeTempDir();
  try {
    seedAtris(dir);
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'hint-pack'], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.match(publish.stdout, /wrote pack\.json for hint-pack 0\.1\.0/);
    assert.match(publish.stdout, /share with: atris pack publish --out <file\.zip> or atris pack publish --push/);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.equal(manifest.slug, 'hint-pack');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish --push exits with login hint when not logged in', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  try {
    seedAtris(dir);
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'push-pack', '--push'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_TOKEN: '',
        ATRIS_PROFILE: '',
        TERM_SESSION_ID: '',
        ITERM_SESSION_ID: '',
        TMUX_PANE: '',
        WT_SESSION: '',
        WEZTERM_PANE: '',
      },
    });
    assert.equal(publish.status, 1, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.match(`${publish.stdout}\n${publish.stderr}`, /not logged in\. run atris login first to publish packs\./);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('pack version comparison sorts semantic versions numerically', () => {
  assert.equal(comparePackVersions('0.2.0', '0.1.9'), 1);
  assert.equal(comparePackVersions('1.0.0', '1.0.0'), 0);
  assert.equal(comparePackVersions('1.2.0', '1.10.0'), -1);
  assert.equal(comparePackVersions('unknown', '0.1.0'), null);
});

test('pack list shows pack folders under cwd and packs', () => {
  const dir = makeTempDir();
  try {
    writePackDir(path.join(dir, 'alpha-pack'), {
      slug: 'alpha-pack',
      title: 'Alpha Pack',
    });
    writePackDir(path.join(dir, 'packs', 'beta-pack'), {
      slug: 'beta-pack',
      title: 'Beta Pack',
      version: '2.0.0',
    });

    const listed = listInstalledPacks(dir);
    assert.deepEqual(listed.packs.map((pack) => pack.manifest.slug), ['alpha-pack', 'beta-pack']);

    const list = runCli(['pack', 'list'], { cwd: dir });
    assert.equal(list.status, 0, `stdout:\n${list.stdout}\nstderr:\n${list.stderr}`);
    assert.match(list.stdout, /alpha-pack\s+Alpha Pack\s+v0\.1\.0\s+alpha-pack/);
    assert.match(list.stdout, /beta-pack\s+Beta Pack\s+v2\.0\.0\s+packs\/beta-pack/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install accepts registry slugs and https zip urls', async () => {
  const dir = makeTempDir();
  try {
    const zipBuffer = packZipBuffer(dir, sampleManifest({ slug: 'g-brain', title: 'G Brain' }));
    const calls = [];
    const deps = {
      getAppBaseUrl: () => 'https://app.test',
      loadCredentials: () => ({ token: 'test-token' }),
      httpRequest: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, body: zipBuffer };
      },
    };

    const slugTarget = path.join(dir, 'from-slug');
    const urlTarget = path.join(dir, 'from-url');
    assert.equal(await installPack(['g-brain', '--dir', slugTarget], dir, { deps }), 0);
    assert.equal(await installPack(['https://packs.test/g-brain.zip', '--dir', urlTarget], dir, { deps }), 0);

    assert.equal(calls[0].url, 'https://app.test/api/pack/registry/g-brain');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(calls[1].url, 'https://packs.test/g-brain.zip');
    assert.ok(fs.existsSync(path.join(slugTarget, 'pack.json')));
    assert.ok(fs.existsSync(path.join(urlTarget, 'pack.json')));
    const slugInstalled = JSON.parse(fs.readFileSync(path.join(slugTarget, 'pack.json'), 'utf8'));
    assert.deepEqual(slugInstalled.origin, { type: 'registry', slug: 'g-brain' });
    const urlInstalled = JSON.parse(fs.readFileSync(path.join(urlTarget, 'pack.json'), 'utf8'));
    assert.deepEqual(urlInstalled.origin, { type: 'url', url: 'https://packs.test/g-brain.zip' });
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install stamps file origin for local zip installs', async () => {
  const dir = makeTempDir();
  try {
    const manifest = sampleManifest({ slug: 'local-pack' });
    const zipPath = path.join(dir, 'local.zip');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# local\n') },
    ]);
    const installDir = path.join(dir, 'installed');
    fs.mkdirSync(installDir, { recursive: true });

    assert.equal(await installPack([zipPath, '--dir', installDir], dir), 0);
    const installed = JSON.parse(fs.readFileSync(path.join(installDir, 'pack.json'), 'utf8'));
    assert.deepEqual(installed.origin, { type: 'file' });
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install preserves origin already present in zip pack.json', async () => {
  const dir = makeTempDir();
  try {
    const existingOrigin = { type: 'registry', slug: 'custom-origin' };
    const zipBuffer = packZipBuffer(dir, sampleManifest({
      slug: 'custom-origin',
      origin: existingOrigin,
    }));
    const calls = [];
    const deps = {
      getAppBaseUrl: () => 'https://app.test',
      loadCredentials: () => ({ token: 'test-token' }),
      httpRequest: async (url) => {
        calls.push(url);
        return { status: 200, body: zipBuffer };
      },
    };

    assert.equal(await installPack(['custom-origin', '--dir', path.join(dir, 'target')], dir, { deps }), 0);
    const installed = JSON.parse(fs.readFileSync(path.join(dir, 'target', 'pack.json'), 'utf8'));
    assert.deepEqual(installed.origin, existingOrigin);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install --force refuses mismatched slug', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, { slug: 'demo-pack', version: '0.1.0' });
    const zipPath = path.join(dir, 'other.zip');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(sampleManifest({ slug: 'other-pack', version: '0.2.0' }), null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# other\n') },
    ]);

    await assert.rejects(
      () => installPack([zipPath, '--dir', target, '--force'], dir),
      /refusing update: existing slug demo-pack does not match other-pack/,
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install --force overwrites zip files and preserves user notes', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, { slug: 'demo-pack', version: '0.1.0', origin: { type: 'file' } });
    fs.writeFileSync(path.join(target, 'notes.txt'), 'my notes stay', 'utf8');

    const zipPath = path.join(dir, 'update.zip');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(sampleManifest({ slug: 'demo-pack', version: '0.2.0' }), null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# updated readme\n') },
    ]);

    assert.equal(await installPack([zipPath, '--dir', target, '--force'], dir), 0);
    assert.ok(fs.existsSync(path.join(target, 'notes.txt')));
    assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'my notes stay');
    const installed = JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8'));
    assert.equal(installed.version, '0.2.0');
    assert.deepEqual(installed.origin, { type: 'file' });
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack update is a no-op when version is unchanged', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, {
      slug: 'demo-pack',
      version: '0.1.0',
      origin: { type: 'registry', slug: 'demo-pack' },
    });
    fs.writeFileSync(path.join(target, 'notes.txt'), 'keep me', 'utf8');

    const zipBuffer = packZipBuffer(dir, sampleManifest({ slug: 'demo-pack', version: '0.1.0' }));
    const calls = [];
    const result = await updatePack([target], dir, {
      deps: {
        getAppBaseUrl: () => 'https://app.test',
        loadCredentials: () => ({ token: 'test-token' }),
        httpRequest: async (url) => {
          calls.push(url);
          return { status: 200, body: zipBuffer };
        },
      },
    });

    assert.equal(result.upToDate, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://app.test/api/pack/registry/demo-pack');
    assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), '# pack\n');
    assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'keep me');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack update upgrades registry packs and preserves user files', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, {
      slug: 'demo-pack',
      version: '0.1.0',
      origin: { type: 'registry', slug: 'demo-pack' },
    });
    fs.writeFileSync(path.join(target, 'notes.txt'), 'user journal', 'utf8');

    const zipBuffer = packZipBuffer(dir, sampleManifest({ slug: 'demo-pack', version: '0.2.0' }));
    const result = await updatePack([target], dir, {
      deps: {
        getAppBaseUrl: () => 'https://app.test',
        loadCredentials: () => ({ token: 'test-token' }),
        httpRequest: async () => ({ status: 200, body: zipBuffer }),
      },
    });

    assert.equal(result.upToDate, false);
    assert.ok(fs.existsSync(path.join(target, 'notes.txt')));
    assert.equal(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'user journal');
    const installed = JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8'));
    assert.equal(installed.version, '0.2.0');
    assert.deepEqual(installed.origin, { type: 'registry', slug: 'demo-pack' });
    assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), '# pack\n');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack pull stages newer remote in upstream and preserves local edits', async () => {
  const dir = makeTempDir();
  let server = null;
  const previousAppUrl = process.env.ATRIS_APP_URL;
  try {
    const localZip = path.join(dir, 'local.zip');
    writeZipFile(localZip, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(sampleManifest({ slug: 'demo-pack', version: '0.1.0' }), null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# local readme\n') },
    ]);

    const target = path.join(dir, 'installed');
    assert.equal(await installPack([localZip, '--dir', target], dir), 0);
    fs.writeFileSync(path.join(target, 'README.md'), '# local edit\n', 'utf8');

    const remoteZip = path.join(dir, 'remote.zip');
    writeZipFile(remoteZip, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(sampleManifest({ slug: 'demo-pack', version: '0.2.0' }), null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# remote readme\n') },
      { name: 'atris/atris.md', data: Buffer.from('# remote atris\n') },
    ]);
    const remoteBuffer = fs.readFileSync(remoteZip);
    const requests = [];
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'GET' && req.url === '/api/pack/registry/demo-pack') {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(remoteBuffer);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    const address = await listen(server);
    process.env.ATRIS_APP_URL = `http://127.0.0.1:${address.port}`;

    const result = await pullPack(['--dir', target], dir);
    assert.equal(result.upToDate, false);
    assert.deepEqual(requests, ['GET /api/pack/registry/demo-pack']);
    assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), '# local edit\n');
    assert.equal(fs.readFileSync(path.join(target, '.upstream', 'README.md'), 'utf8'), '# remote readme\n');
    assert.equal(fs.readFileSync(path.join(target, '.upstream', 'atris', 'atris.md'), 'utf8'), '# remote atris\n');

    const upstreamManifest = JSON.parse(fs.readFileSync(path.join(target, '.upstream', 'pack.json'), 'utf8'));
    assert.equal(upstreamManifest.version, '0.2.0');
    const state = JSON.parse(fs.readFileSync(path.join(target, '.upstream', 'STATE.json'), 'utf8'));
    assert.equal(state.slug, 'demo-pack');
    assert.equal(state.localVersion, '0.1.0');
    assert.equal(state.remoteVersion, '0.2.0');
    assert.ok(state.pulledAt);
  } finally {
    if (previousAppUrl === undefined) {
      delete process.env.ATRIS_APP_URL;
    } else {
      process.env.ATRIS_APP_URL = previousAppUrl;
    }
    if (server) await closeServer(server);
    cleanupTempDir(dir);
  }
});

test('pack status prints never pulled and last pulled remote version', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, { slug: 'demo-pack', version: '0.1.0' });

    const neverPulled = runCli(['pack', 'status', '--dir', target], { cwd: dir });
    assert.equal(neverPulled.status, 0, `stdout:\n${neverPulled.stdout}\nstderr:\n${neverPulled.stderr}`);
    assert.match(neverPulled.stdout, /demo-pack local v0\.1\.0, remote never pulled/);

    fs.mkdirSync(path.join(target, '.upstream'), { recursive: true });
    fs.writeFileSync(path.join(target, '.upstream', 'STATE.json'), `${JSON.stringify({
      slug: 'demo-pack',
      localVersion: '0.1.0',
      remoteVersion: '0.2.0',
      pulledAt: '2026-07-09T12:00:00.000Z',
    }, null, 2)}\n`);

    const pulled = runCli(['pack', 'status', '--dir', target], { cwd: dir });
    assert.equal(pulled.status, 0, `stdout:\n${pulled.stdout}\nstderr:\n${pulled.stderr}`);
    assert.match(pulled.stdout, /demo-pack local v0\.1\.0, last pulled remote v0\.2\.0/);
    assert.match(pulled.stdout, /pulled at 2026-07-09T12:00:00\.000Z/);
  } finally {
    cleanupTempDir(dir);
  }
});
