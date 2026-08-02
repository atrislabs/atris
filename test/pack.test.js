const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readZipFile, writeZipFile, ZIP_LIMITS } = require('../lib/zip');
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

async function captureConsole(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
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

test('pack publish --author writes the author into the manifest', () => {
  const dir = makeTempDir();
  try {
    seedAtris(dir);
    const zipPath = path.join(dir, 'authored.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'authored-pack', '--author', 'Ada Lovelace', '--out', zipPath], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);

    const target = path.join(dir, 'installed');
    const install = runCli(['pack', 'install', zipPath, '--dir', target], { cwd: dir });
    assert.equal(install.status, 0, `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8'));
    assert.equal(manifest.author, 'Ada Lovelace');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish --out then install round trips atris and manifest', () => {
  const dir = makeTempDir();
  try {
    seedAtris(dir);
    const zipPath = path.join(dir, 'demo.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'demo-pack', '--author', 'Ada Lovelace', '--notes', 'first publish', '--out', zipPath], { cwd: dir });
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

test('pack install prints its absolute destination and local source before writing', async () => {
  const dir = makeTempDir();
  try {
    const zipPath = path.join(dir, 'demo.zip');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(sampleManifest(), null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# pack\n') },
    ]);
    const target = path.join(dir, 'installed');
    let destinationPrintedBeforeWrite = false;
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => {
      const line = args.join(' ');
      if (line === `destination: ${target}`) {
        destinationPrintedBeforeWrite = !fs.existsSync(path.join(target, 'pack.json'));
      }
      lines.push(line);
    };
    try {
      assert.equal(await installPack([zipPath, '--dir', target], dir, {
        deps: { getAppBaseUrl: () => 'https://app.test' },
      }), 0);
    } finally {
      console.log = originalLog;
    }

    assert.equal(destinationPrintedBeforeWrite, true);
    assert.equal(lines[0], `destination: ${target}`);
    assert.equal(lines[1], `source file: ${zipPath}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install rejects oversized declared content before writing', async () => {
  const dir = makeTempDir();
  try {
    const zipPath = path.join(dir, 'declared-bomb.zip');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(sampleManifest(), null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# tiny compressed body\n') },
    ]);
    const zip = fs.readFileSync(zipPath);
    const centralHeader = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const firstCentralOffset = zip.indexOf(centralHeader);
    const secondCentralOffset = zip.indexOf(centralHeader, firstCentralOffset + centralHeader.length);
    assert.notEqual(secondCentralOffset, -1);
    zip.writeUInt32LE(ZIP_LIMITS.maxEntryBytes + 1, secondCentralOffset + 24);
    fs.writeFileSync(zipPath, zip);

    const target = path.join(dir, 'installed');
    await assert.rejects(
      () => installPack([zipPath, '--dir', target], dir),
      /entry README\.md declares .* exceeding .* byte entry limit/,
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install warns how many packet files will be untracked in an existing git repo', async () => {
  const dir = makeTempDir();
  try {
    const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const zipPath = path.join(dir, 'demo.zip');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(`${JSON.stringify(sampleManifest(), null, 2)}\n`) },
      { name: 'README.md', data: Buffer.from('# pack\n') },
    ]);
    const target = path.join(dir, 'packs', 'demo-pack');
    const { result, output } = await captureConsole(() => installPack(
      [zipPath, '--dir', target],
      dir,
      { deps: { getAppBaseUrl: () => 'https://app.test' } },
    ));

    assert.equal(result, 0);
    assert.match(output, new RegExp(`warning: 2 files will be added untracked to git repository ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'safe-pack', '--author', 'Ada Lovelace', '--out', zipPath], { cwd: dir });
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

test('pack install rejects invalid manifest shapes before writing any files', async () => {
  const dir = makeTempDir();
  try {
    const cases = [
      {
        name: 'missing',
        entries: [{ name: 'README.md', data: Buffer.from('# no manifest\n') }],
        error: /missing root pack\.json/,
      },
      {
        name: 'malformed',
        entries: [{ name: 'pack.json', data: Buffer.from('{not json') }],
        error: /invalid pack\.json/,
      },
      {
        name: 'missing-slug',
        entries: [{ name: 'pack.json', data: Buffer.from('{}') }],
        error: /pack\.json is missing slug/,
      },
      {
        name: 'duplicate-manifest',
        entries: [
          { name: 'pack.json', data: Buffer.from(JSON.stringify({ slug: 'first-pack' })) },
          { name: './pack.json', data: Buffer.from(JSON.stringify({ slug: 'swapped-pack' })) },
        ],
        error: /duplicate pack\.json entries/,
      },
    ];

    for (const item of cases) {
      const zipPath = path.join(dir, `${item.name}.zip`);
      const target = path.join(dir, `${item.name}-target`);
      writeZipFile(zipPath, item.entries);
      await assert.rejects(() => installPack([zipPath, '--dir', target], dir), item.error);
      assert.equal(fs.existsSync(target), false, `${item.name} must not leave a partial target`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install rejects duplicate normalized paths before writing', async () => {
  const dir = makeTempDir();
  try {
    const zipPath = path.join(dir, 'duplicate-path.zip');
    const target = path.join(dir, 'target');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(JSON.stringify(sampleManifest())) },
      { name: 'README.md', data: Buffer.from('# first\n') },
      { name: './README.md', data: Buffer.from('# second\n') },
    ]);

    await assert.rejects(
      () => installPack([zipPath, '--dir', target], dir),
      /refusing duplicate zip entry/,
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack install refuses writes through symlinked target components', async () => {
  const dir = makeTempDir();
  try {
    const zipPath = path.join(dir, 'symlink.zip');
    const target = path.join(dir, 'target');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(target, 'linked'), 'dir');
    writeZipFile(zipPath, [
      { name: 'pack.json', data: Buffer.from(JSON.stringify(sampleManifest())) },
      { name: 'linked/escaped.txt', data: Buffer.from('escaped\n') },
    ]);

    await assert.rejects(
      () => installPack([zipPath, '--dir', target], dir),
      /refusing zip entry through symlinked target/,
    );
    assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false);
    assert.equal(fs.existsSync(path.join(target, 'pack.json')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('registry install rejects a manifest slug that differs from the requested slug', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'target');
    const zipBuffer = packZipBuffer(dir, sampleManifest({ slug: 'different-pack' }));
    const deps = {
      getAppBaseUrl: () => 'https://app.test',
      loadCredentials: () => null,
      httpRequest: async () => ({ status: 200, body: zipBuffer }),
    };

    await assert.rejects(
      () => installPack(['expected-pack', '--dir', target], dir, { deps }),
      /registry returned different slug: different-pack/,
    );
    assert.equal(fs.existsSync(target), false);
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
    const first = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'version-pack', '--author', 'Ada Lovelace', '--out', firstZip], { cwd: dir });
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    const second = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'version-pack', '--author', 'Ada Lovelace', '--out', secondZip], { cwd: dir });
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'pack.json'), 'utf8'));
    assert.equal(manifest.version, '0.1.1');
    assert.deepEqual(manifest.versions.map((entry) => entry.version), ['0.1.0', '0.1.1']);
    const zipManifest = JSON.parse(readZipFile(secondZip).find((entry) => entry.name === 'pack.json').data.toString('utf8'));
    assert.equal(zipManifest.version, '0.1.1');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish preserves private visibility and price in the archive manifest', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'private-pack');
    writePackDir(packDir, {
      slug: 'private-pack',
      author: 'Ada Lovelace',
      visibility: 'private',
      priceCents: 2500,
    });
    const zipPath = path.join(dir, 'private-pack.zip');
    const publish = runCli(['pack', 'publish', '--dir', packDir, '--out', zipPath], { cwd: dir });

    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
    const zipManifest = JSON.parse(
      readZipFile(zipPath).find((entry) => entry.name === 'pack.json').data.toString('utf8'),
    );
    assert.equal(sourceManifest.visibility, 'private');
    assert.equal(sourceManifest.priceCents, 2500);
    assert.equal(zipManifest.visibility, 'private');
    assert.equal(zipManifest.priceCents, 2500);
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
    assert.ok(!fs.existsSync(path.join(dir, 'pack.json')), 'publish must not write pack.json outside the pack dir');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'pack.json'), 'utf8'));
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
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'push-pack', '--author', 'Ada Lovelace', '--push'], {
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

test('pack inspect resolves an installed slug and prints its trust surface', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'packs', 'trust-pack-folder');
    writePackDir(target, {
      slug: 'trust-pack',
      author: 'Ada Lovelace',
      type: 'workflow',
      entrypoint: { command: 'node run.js', verifier: 'node --test' },
      permissions: { network: 'read', filesystem: 'pack only' },
      provenance: {
        'created-in': 'browser',
        'source-urls': ['https://example.com/source'],
        'content-hashes': { 'README.md': 'sha256:abc123' },
      },
      origin: { type: 'registry', slug: 'trust-pack' },
    });
    fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(target, 'docs', 'guide.md'), '# guide\n', 'utf8');
    fs.mkdirSync(path.join(target, '.upstream'), { recursive: true });
    fs.writeFileSync(path.join(target, '.upstream', 'STATE.json'), `${JSON.stringify({
      slug: 'trust-pack',
      localVersion: '0.1.0',
      remoteVersion: '0.2.0',
      pulledAt: '2026-08-02T01:00:00.000Z',
    }, null, 2)}\n`);

    const inspected = runCli(['pack', 'inspect', 'trust-pack'], {
      cwd: dir,
      env: { ATRIS_APP_URL: 'https://registry.test' },
    });
    assert.equal(inspected.status, 0, `stdout:\n${inspected.stdout}\nstderr:\n${inspected.stderr}`);
    const realTarget = fs.realpathSync(target);
    assert.match(inspected.stdout, new RegExp(`location: ${realTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(inspected.stdout, /registry origin:\n  slug: trust-pack\n  url: https:\/\/registry\.test\/packs\/trust-pack/);
    assert.match(inspected.stdout, /installed version: 0\.1\.0/);
    assert.match(inspected.stdout, /update state: last pulled remote v0\.2\.0 at 2026-08-02T01:00:00\.000Z/);
    assert.match(inspected.stdout, /files: 4, total size \d+(?:\.\d+)? (?:B|KB)/);
    assert.match(inspected.stdout, /top-level tree:/);
    assert.match(inspected.stdout, /docs\/ \(1 file, 8 B\)/);
    assert.match(inspected.stdout, /pack type: workflow/);
    assert.match(inspected.stdout, /entrypoint: \{"command":"node run\.js","verifier":"node --test"\}/);
    assert.match(inspected.stdout, /permissions: \{"network":"read","filesystem":"pack only"\}/);
    assert.match(inspected.stdout, /author: Ada Lovelace \[present\]/);
    assert.match(inspected.stdout, /created-in: browser \[present\]/);
    assert.match(inspected.stdout, /source urls: \["https:\/\/example\.com\/source"\] \[present\]/);
    assert.match(inspected.stdout, /content hashes: \{"README\.md":"sha256:abc123"\} \[present\]/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack inspect accepts a directory and makes missing contracts visible', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'local-pack');
    writePackDir(target, { slug: 'local-pack', author: '' });

    const missingEntrypoint = runCli(['pack', 'inspect', target], { cwd: dir });
    assert.equal(missingEntrypoint.status, 0, `stdout:\n${missingEntrypoint.stdout}\nstderr:\n${missingEntrypoint.stderr}`);
    assert.match(missingEntrypoint.stdout, /entrypoint: none: this pack has no actionable entry contract/);

    fs.writeFileSync(path.join(target, 'RUN.md'), '# run this pack\n', 'utf8');

    const inspected = runCli(['pack', 'inspect', target], { cwd: dir });
    assert.equal(inspected.status, 0, `stdout:\n${inspected.stdout}\nstderr:\n${inspected.stderr}`);
    assert.match(inspected.stdout, /registry origin: ABSENT/);
    assert.match(inspected.stdout, /update state: remote not checked yet/);
    assert.match(inspected.stdout, /pack type: undeclared/);
    assert.match(inspected.stdout, /entrypoint: RUN\.md/);
    assert.match(inspected.stdout, /permissions: none declared/);
    assert.match(inspected.stdout, /author: ABSENT/);
    assert.match(inspected.stdout, /created-in: ABSENT/);
    assert.match(inspected.stdout, /source urls: ABSENT/);
    assert.match(inspected.stdout, /content hashes: ABSENT/);
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
    const slugInstall = await captureConsole(() => installPack(['g-brain', '--dir', slugTarget], dir, { deps }));
    const urlInstall = await captureConsole(() => installPack(['https://packs.test/g-brain.zip', '--dir', urlTarget], dir, { deps }));
    assert.equal(slugInstall.result, 0);
    assert.equal(urlInstall.result, 0);
    assert.match(slugInstall.output, /registry url: https:\/\/app\.test\/api\/pack\/registry\/g-brain/);
    assert.match(urlInstall.output, /source url: https:\/\/packs\.test\/g-brain\.zip/);
    assert.doesNotMatch(urlInstall.output, /registry url:/);

    assert.equal(calls[0].url, 'https://app.test/api/pack/registry/g-brain');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(calls[1].url, 'https://packs.test/g-brain.zip');
    assert.ok(fs.existsSync(path.join(slugTarget, 'pack.json')));
    assert.ok(fs.existsSync(path.join(urlTarget, 'pack.json')));
    const slugInstalled = JSON.parse(fs.readFileSync(path.join(slugTarget, 'pack.json'), 'utf8'));
    assert.deepEqual(slugInstalled.origin, { type: 'registry', slug: 'g-brain' });
    const slugState = JSON.parse(fs.readFileSync(path.join(slugTarget, '.atris', 'state', 'pack.json'), 'utf8'));
    assert.equal(slugState.remoteVersion, '0.1.0');
    assert.equal(slugState.origin.slug, 'g-brain');
    assert.ok(slugState.lastRemoteCheckAt);
    const urlInstalled = JSON.parse(fs.readFileSync(path.join(urlTarget, 'pack.json'), 'utf8'));
    assert.deepEqual(urlInstalled.origin, { type: 'url', url: 'https://packs.test/g-brain.zip' });
    assert.ok(!fs.existsSync(path.join(urlTarget, '.atris', 'state', 'pack.json')));
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
    const state = JSON.parse(fs.readFileSync(path.join(target, '.atris', 'state', 'pack.json'), 'utf8'));
    assert.equal(state.remoteVersion, '0.1.0');
    assert.equal(state.origin.slug, 'demo-pack');
    assert.ok(state.lastRemoteCheckAt);

    const status = runCli(['pack', 'status', '--dir', target], { cwd: dir });
    assert.equal(status.status, 0, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`);
    assert.match(status.stdout, /demo-pack installed v0\.1\.0/);
    assert.match(status.stdout, /registry origin demo-pack/);
    assert.match(status.stdout, new RegExp(`last remote check ${state.lastRemoteCheckAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, remote v0\\.1\\.0`));
    assert.doesNotMatch(status.stdout, /staged upstream review/);
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
    const state = JSON.parse(fs.readFileSync(path.join(target, '.atris', 'state', 'pack.json'), 'utf8'));
    assert.equal(state.remoteVersion, '0.2.0');
    assert.ok(state.lastRemoteCheckAt);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack update refreshes stale credentials after a private registry 404', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'private-pack');
    writePackDir(target, {
      slug: 'private-pack',
      version: '0.1.0',
      origin: { type: 'registry', slug: 'private-pack' },
    });
    const zipBuffer = packZipBuffer(dir, sampleManifest({ slug: 'private-pack', version: '0.2.0' }));
    let credentials = {
      token: 'stale-token',
      refresh_token: 'refresh-token',
      provider: 'google',
    };
    const downloadCalls = [];
    const refreshCalls = [];

    const result = await updatePack([target], dir, {
      deps: {
        getAppBaseUrl: () => 'https://app.test',
        loadCredentials: () => credentials,
        httpRequest: async (url, options) => {
          downloadCalls.push({ url, options });
          if (downloadCalls.length === 1) return { status: 404, body: Buffer.alloc(0) };
          return { status: 200, body: zipBuffer };
        },
        apiRequestJson: async (pathname, options) => {
          refreshCalls.push({ pathname, options });
          return { ok: true, status: 200, data: { access_token: 'fresh-token' } };
        },
        performTokenRefresh: async (loadedCredentials, requestJson) => {
          const refreshed = await requestJson('/auth/refresh', {
            method: 'POST',
            body: {
              refresh_token: loadedCredentials.refresh_token,
              provider: loadedCredentials.provider,
            },
          });
          credentials = { ...loadedCredentials, token: refreshed.data.access_token };
          return { ok: true, payload: { credentials } };
        },
      },
    });

    assert.equal(result.upToDate, false);
    assert.equal(downloadCalls.length, 2);
    assert.equal(downloadCalls[0].options.headers.Authorization, 'Bearer stale-token');
    assert.equal(downloadCalls[1].options.headers.Authorization, 'Bearer fresh-token');
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].pathname, '/auth/refresh');
    assert.deepEqual(refreshCalls[0].options.body, { refresh_token: 'refresh-token' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8')).version, '0.2.0');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack update reports stale access after one refreshed retry still returns 404', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'private-pack');
    writePackDir(target, {
      slug: 'private-pack',
      origin: { type: 'registry', slug: 'private-pack' },
    });
    const calls = [];

    await assert.rejects(
      () => updatePack([target], dir, {
        deps: {
          getAppBaseUrl: () => 'https://app.test',
          loadCredentials: () => ({ token: 'stale-token', refresh_token: 'refresh-token' }),
          httpRequest: async (url, options) => {
            calls.push({ url, options });
            return { status: 404, body: Buffer.alloc(0) };
          },
          performTokenRefresh: async () => ({
            ok: true,
            payload: { credentials: { token: 'fresh-token', refresh_token: 'refresh-token' } },
          }),
        },
      }),
      /pack not found or you do not have access \(your login may be stale; try atris login\)/,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer fresh-token');
  } finally {
    cleanupTempDir(dir);
  }
});

test('anonymous registry 404 stays a plain pack not found error', async () => {
  const dir = makeTempDir();
  try {
    const calls = [];
    await assert.rejects(
      () => installPack(['missing-pack', '--dir', path.join(dir, 'target')], dir, {
        deps: {
          getAppBaseUrl: () => 'https://app.test',
          loadCredentials: () => null,
          httpRequest: async (url, options) => {
            calls.push({ url, options });
            return { status: 404, body: Buffer.alloc(0) };
          },
        },
      }),
      /pack not found: missing-pack/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack update validates duplicate paths before changing files or remote state', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, {
      slug: 'demo-pack',
      version: '0.1.0',
      origin: { type: 'registry', slug: 'demo-pack' },
    });
    const remoteZip = path.join(dir, 'remote.zip');
    writeZipFile(remoteZip, [
      { name: 'pack.json', data: Buffer.from(JSON.stringify(sampleManifest({ version: '0.2.0' }))) },
      { name: 'README.md', data: Buffer.from('# remote first\n') },
      { name: './README.md', data: Buffer.from('# remote second\n') },
    ]);

    await assert.rejects(
      () => updatePack([target], dir, {
        deps: {
          getAppBaseUrl: () => 'https://app.test',
          loadCredentials: () => null,
          httpRequest: async () => ({ status: 200, body: fs.readFileSync(remoteZip) }),
        },
      }),
      /refusing duplicate zip entry/,
    );

    assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), '# pack\n');
    assert.equal(fs.existsSync(path.join(target, '.atris', 'state', 'pack.json')), false);
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
    const localState = JSON.parse(fs.readFileSync(path.join(target, '.atris', 'state', 'pack.json'), 'utf8'));
    assert.equal(localState.remoteVersion, '0.2.0');
    assert.deepEqual(localState.origin, { type: 'registry', slug: 'demo-pack' });
    assert.ok(localState.lastRemoteCheckAt);
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

test('pack pull records an equal remote check without staging a review', async () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, { slug: 'demo-pack', version: '0.1.0' });
    const zipBuffer = packZipBuffer(dir, sampleManifest({ slug: 'demo-pack', version: '0.1.0' }));

    const result = await pullPack(['--dir', target], dir, {
      deps: {
        now: () => new Date('2026-07-09T14:00:00.000Z'),
        getAppBaseUrl: () => 'https://app.test',
        loadCredentials: () => null,
        httpRequest: async () => ({ status: 200, body: zipBuffer }),
      },
    });

    assert.equal(result.upToDate, true);
    assert.ok(!fs.existsSync(path.join(target, '.upstream')));
    const state = JSON.parse(fs.readFileSync(path.join(target, '.atris', 'state', 'pack.json'), 'utf8'));
    assert.equal(state.remoteVersion, '0.1.0');
    assert.equal(state.lastRemoteCheckAt, '2026-07-09T14:00:00.000Z');

    const status = runCli(['pack', 'status', '--dir', target], { cwd: dir });
    assert.match(status.stdout, /last remote check 2026-07-09T14:00:00\.000Z, remote v0\.1\.0/);
    assert.doesNotMatch(status.stdout, /staged upstream review/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack status separates remote checks from staged upstream review', () => {
  const dir = makeTempDir();
  try {
    const target = path.join(dir, 'demo-pack');
    writePackDir(target, {
      slug: 'demo-pack',
      version: '0.1.0',
      origin: { type: 'file' },
    });

    const neverChecked = runCli(['pack', 'status', '--dir', target], { cwd: dir });
    assert.equal(neverChecked.status, 0, `stdout:\n${neverChecked.stdout}\nstderr:\n${neverChecked.stderr}`);
    assert.match(neverChecked.stdout, /demo-pack installed v0\.1\.0/);
    assert.match(neverChecked.stdout, /registry origin none/);
    assert.match(neverChecked.stdout, /remote not checked yet/);
    assert.doesNotMatch(neverChecked.stdout, /staged upstream review/);

    writePackDir(target, {
      slug: 'demo-pack',
      version: '0.1.0',
      origin: { type: 'registry', slug: 'demo-pack' },
    });
    const legacyRegistryInstall = runCli(['pack', 'status', '--dir', target], { cwd: dir });
    assert.match(legacyRegistryInstall.stdout, /registry origin demo-pack/);
    assert.match(legacyRegistryInstall.stdout, /last remote check time unknown, remote v0\.1\.0/);
    assert.doesNotMatch(legacyRegistryInstall.stdout, /remote not checked yet/);

    fs.mkdirSync(path.join(target, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(target, '.atris', 'state', 'pack.json'), `${JSON.stringify({
      slug: 'demo-pack',
      origin: { type: 'registry', slug: 'demo-pack' },
      remoteVersion: '0.1.0',
      lastRemoteCheckAt: '2026-07-09T13:00:00.000Z',
    }, null, 2)}\n`);

    fs.mkdirSync(path.join(target, '.upstream'), { recursive: true });
    fs.writeFileSync(path.join(target, '.upstream', 'pack.json'), `${JSON.stringify(sampleManifest({
      slug: 'demo-pack',
      version: '0.2.0',
    }), null, 2)}\n`);
    fs.writeFileSync(path.join(target, '.upstream', 'STATE.json'), `${JSON.stringify({
      slug: 'demo-pack',
      localVersion: '0.1.0',
      remoteVersion: '0.2.0',
      pulledAt: '2026-07-09T12:00:00.000Z',
    }, null, 2)}\n`);

    const pulled = runCli(['pack', 'status', '--dir', target], { cwd: dir });
    assert.equal(pulled.status, 0, `stdout:\n${pulled.stdout}\nstderr:\n${pulled.stderr}`);
    assert.match(pulled.stdout, /last remote check 2026-07-09T13:00:00\.000Z, remote v0\.1\.0/);
    assert.match(pulled.stdout, /staged upstream review remote v0\.2\.0 at 2026-07-09T12:00:00\.000Z/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish preserves entry contract and provenance fields', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      name: 'contract-pack', slug: 'contract-pack', title: 'Contract Pack', description: 'd',
      author: 'Ada', tags: [], version: '0.0.1',
      versions: [{ version: '0.0.1', date: '2026-08-02', notes: 'seed' }],
      type: 'skill',
      entrypoint: 'RUN.md',
      'created-in': 'test suite',
      'source-urls': ['https://example.com/source'],
      'content-hashes': { 'RUN.md': 'abc123' },
    }));
    fs.writeFileSync(path.join(dir, 'RUN.md'), '# first action\n');

    const zipPath = path.join(os.tmpdir(), `contract-pack-${process.pid}.zip`);
    const publish = runCli(['pack', 'publish', '--author', 'Ada', '--out', zipPath], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);

    const target = path.join(dir, 'installed');
    const install = runCli(['pack', 'install', zipPath, '--dir', target], { cwd: dir });
    assert.equal(install.status, 0, `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`);
    const installed = JSON.parse(fs.readFileSync(path.join(target, 'pack.json'), 'utf8'));
    assert.equal(installed.type, 'skill');
    assert.equal(installed.entrypoint, 'RUN.md');
    assert.equal(installed['created-in'], 'test suite');
    assert.deepEqual(installed['source-urls'], ['https://example.com/source']);
    assert.deepEqual(installed['content-hashes'], { 'RUN.md': 'abc123' });

    const inspected = runCli(['pack', 'inspect', target], { cwd: dir });
    assert.equal(inspected.status, 0);
    assert.match(inspected.stdout, /entrypoint: RUN.md/);
    assert.doesNotMatch(inspected.stdout, /source urls: ABSENT/);
    fs.rmSync(zipPath, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pack publish from a pack root ships the whole folder except junk', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.upstream'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      name: 'root-pack', slug: 'root-pack', title: 'Root Pack', description: 'd',
      author: '', tags: [], version: '0.0.1',
      versions: [{ version: '0.0.1', date: '2026-07-09', notes: 'seed' }],
    }));
    fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# boot\n');
    fs.writeFileSync(path.join(dir, 'wiki', 'concept.md'), '# concept\nsource: https://example.com\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# root pack\n');
    fs.writeFileSync(path.join(dir, '.upstream', 'STATE.json'), '{}');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'x');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');

    const zipPath = path.join(os.tmpdir(), `root-pack-${process.pid}.zip`);
    const publish = runCli(['pack', 'publish', '--author', 'Ada Lovelace', '--out', zipPath], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);

    const names = readZipFile(zipPath).map((entry) => entry.name);
    assert.ok(names.includes('wiki/concept.md'), `missing wiki page in ${names.join(', ')}`);
    assert.ok(names.includes('README.md'));
    assert.ok(names.includes('atris/atris.md'));
    assert.ok(!names.some((n) => n.startsWith('.upstream')));
    assert.ok(!names.some((n) => n.includes('node_modules')));
    assert.ok(!names.some((n) => n.includes('.env')));
    fs.rmSync(zipPath, { force: true });
  } finally {
    cleanupTempDir(dir);
  }
});

for (const sub of ['list', 'status', 'pull', 'update', 'inspect', 'publish']) {
  for (const flag of ['--help', '-h']) {
    test(`pack ${sub} ${flag} shows usage and exits 0 (not "unknown argument")`, () => {
      const dir = makeTempDir();
      try {
        const r = runCli(['pack', sub, flag], { cwd: dir });
        assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
        assert.match(r.stdout, /usage: atris pack/);
        assert.doesNotMatch(`${r.stdout}${r.stderr}`, /unknown pack .* argument/);
      } finally {
        cleanupTempDir(dir);
      }
    });
  }
}
