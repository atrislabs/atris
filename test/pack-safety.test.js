const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readZipFile } = require('../lib/zip');
const {
  classifyPacketPath,
  collectPacketEntries,
  scanTextForSecrets,
  redactSecret,
  registryLimitFailures,
  REGISTRY_LIMITS,
} = require('../commands/pack');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-packet-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

// A workspace with a real knowledge spine and real runtime exhaust around it.
function seedWorkspace(dir) {
  const atrisDir = path.join(dir, 'atris');
  write(path.join(atrisDir, 'MAP.md'), '# Map\n');
  write(path.join(atrisDir, 'atris.md'), '# Atris\n');
  write(path.join(atrisDir, 'wiki', 'page.md'), '# Page\n');
  write(path.join(atrisDir, 'team', 'architect', 'MEMBER.md'), '# Architect\n');
  write(path.join(atrisDir, 'features', 'orb', 'idea.md'), '# Orb\n');
  write(path.join(atrisDir, 'policies', 'OUTBOUND.md'), 'never outbound to customers\n');
  write(path.join(atrisDir, 'refs', 'MODELS.md'), '# Models\n');
  // exhaust
  write(path.join(atrisDir, 'runs', 'mission-1.json'), '{"ok":true}\n');
  write(path.join(atrisDir, 'logs', '2026-07-27.md'), 'log\n');
  write(path.join(atrisDir, 'journal', 'bridge.stderr.log'), 'noise\n');
  write(path.join(atrisDir, 'status', 'now.md'), 'status\n');
  write(path.join(atrisDir, '.atris', 'state', 'cache.json'), '{}\n');
  write(path.join(atrisDir, 'node_modules', 'esbuild', 'index.js'), 'x\n');
  write(path.join(atrisDir, 'features', 'orb', 'package-lock.json'), '{}\n');
  // proof folders are readable markdown, but they are receipts, not knowledge
  write(path.join(atrisDir, 'features', 'orb', 'proof', 'run-1.md'), '# Run 1\n');
  write(path.join(atrisDir, 'features', 'orb', 'proof', 'nested', 'deep', 'out.json'), '{"ok":true}\n');
  write(path.join(atrisDir, 'features', 'orb', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  // customer folders are not knowledge
  write(path.join(atrisDir, 'pallet', 'contract.md'), 'private\n');
  write(path.join(atrisDir, 'deals', 'pipeline.md'), 'private\n');
  return atrisDir;
}

function runCli(args, { cwd, env = {} }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...env },
  });
  if (result.error) throw result.error;
  return result;
}

// ── allowlist ───────────────────────────────────────────────────────────────

test('packet allowlist ships the knowledge spine and nothing else', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = seedWorkspace(dir);
    const { entries, skipped } = collectPacketEntries(atrisDir, { prefix: 'atris' });
    const names = entries.map((entry) => entry.name).sort();

    assert.deepEqual(names, [
      'atris/MAP.md',
      'atris/atris.md',
      'atris/features/orb/idea.md',
      'atris/policies/OUTBOUND.md',
      'atris/refs/MODELS.md',
      'atris/team/architect/MEMBER.md',
      'atris/wiki/page.md',
    ]);

    const reasons = new Map(skipped.map((item) => [item.path, item.reason]));
    assert.match(reasons.get('atris/runs/'), /runtime exhaust/);
    assert.match(reasons.get('atris/logs/'), /runtime exhaust/);
    assert.match(reasons.get('atris/journal/'), /runtime exhaust/);
    assert.match(reasons.get('atris/status/'), /runtime exhaust/);
    assert.match(reasons.get('atris/.atris/'), /runtime exhaust/);
    assert.match(reasons.get('atris/node_modules/'), /runtime exhaust/);
    assert.match(reasons.get('atris/pallet/'), /not in the packet allowlist/);
    assert.match(reasons.get('atris/deals/'), /not in the packet allowlist/);
    assert.match(reasons.get('atris/features/orb/package-lock.json'), /lockfile/);
    assert.match(reasons.get('atris/features/orb/proof/'), /proof artifacts are excluded/);
    assert.match(reasons.get('atris/features/orb/shot.png'), /not a text file type/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('packet allowlist judges atris/ and pack-root paths by the same table', () => {
  for (const prefix of ['', 'atris/']) {
    assert.equal(classifyPacketPath(`${prefix}wiki/page.md`).ok, true);
    assert.equal(classifyPacketPath(`${prefix}MAP.md`).ok, true);
    assert.equal(classifyPacketPath(`${prefix}runs/mission.json`).ok, false);
    assert.equal(classifyPacketPath(`${prefix}features/x/deep/runs/out.json`).ok, false);
    assert.equal(classifyPacketPath(`${prefix}business/customer.md`).ok, false);
    assert.equal(classifyPacketPath(`${prefix}credentials.json`).ok, false);
    assert.equal(classifyPacketPath(`${prefix}features/x/server.pem`).ok, false);
    assert.equal(classifyPacketPath(`${prefix}features/x/app.py`).ok, false);
    assert.equal(classifyPacketPath(`${prefix}notes.json`).ok, false, 'root files are documents only');
  }
});

// Proof runs were 76% of the unpacked weight of the real backend workspace.
// A packet carries the feature definition; the receipts stay home.
test('packet allowlist excludes proof artifacts at any depth', () => {
  for (const prefix of ['', 'atris/']) {
    const shallow = classifyPacketPath(`${prefix}features/orb/proof/run-1.md`);
    assert.equal(shallow.ok, false);
    assert.match(shallow.reason, /proof artifacts are excluded/);

    const deep = classifyPacketPath(`${prefix}features/orb/proof/nested/deep/out.json`);
    assert.equal(deep.ok, false);
    assert.match(deep.reason, /proof artifacts are excluded/);

    assert.equal(classifyPacketPath(`${prefix}features/orb/proof`, { isDirectory: true }).ok, false);
    // the feature definition itself still ships
    assert.equal(classifyPacketPath(`${prefix}features/orb/README.md`).ok, true);
    // and a file that merely mentions proof is not a proof folder
    assert.equal(classifyPacketPath(`${prefix}features/orb/proof-plan.md`).ok, true);
  }
});

test('packet allowlist refuses non-utf8 files even with an allowed extension', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    write(path.join(atrisDir, 'MAP.md'), '# Map\n');
    write(path.join(atrisDir, 'wiki', 'blob.md'), Buffer.from([0x48, 0x00, 0xff, 0xfe, 0x49]));
    const { entries, skipped } = collectPacketEntries(atrisDir, { prefix: 'atris' });
    assert.deepEqual(entries.map((entry) => entry.name), ['atris/MAP.md']);
    assert.equal(skipped.find((item) => item.path === 'atris/wiki/blob.md').reason, 'not valid utf-8 text');
  } finally {
    cleanupTempDir(dir);
  }
});

// ── secret scanner ──────────────────────────────────────────────────────────

const SECRET_CASES = [
  ['jwt', 'auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['api key', 'openai sk-proj-abcd1234EFGH5678ijkl9012MNOP'],
  ['api key', 'gh ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'],
  ['api key', 'aws AKIAIOSFODNN7EXAMPLE'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ['database url with password', 'DATABASE=postgres://atris:h7Kd93ncPq@db.example.com:5432/prod'],
  ['inline credential', 'api_key: 9fK2mQ7xL0aZ4bT8vN1sR6'],
];

for (const [label, line] of SECRET_CASES) {
  test(`secret scanner catches ${label}: ${line.slice(0, 24)}...`, () => {
    const findings = scanTextForSecrets(`# doc\n${line}\n`);
    assert.ok(findings.length >= 1, `no finding for ${line}`);
    assert.equal(findings[0].line, 2);
    assert.ok(findings.some((finding) => finding.label === label), `expected label ${label}, got ${findings.map((f) => f.label).join(',')}`);
    for (const finding of findings) {
      assert.ok(!line.includes(finding.redacted), 'the redacted match must not be the credential');
      assert.match(finding.redacted, /\*/);
    }
  });
}

test('secret scanner passes a clean doc and the code samples that live beside it', () => {
  const clean = [
    '# Wiki page',
    'We store the key in `~/.atris/secrets/ramp/API_KEY` (local).',
    'const token = process.env.GITHUB_TOKEN;',
    'api_key = os.environ["OPENAI_API_KEY"]',
    'Set `ALLOW_DEV_AUTH_BYPASS=true` for local testing.',
    'password: <your-password-here>',
    'token: xxxxxxxxxxxxxxxx',
    'secret: changeme-please',
    'See https://example.com/docs for the postgres://localhost:5432/dev url.',
  ].join('\n');
  assert.deepEqual(scanTextForSecrets(clean), []);
});

test('redactSecret never echoes the credential', () => {
  const value = '9fK2mQ7xL0aZ4bT8vN1sR6';
  const redacted = redactSecret(value);
  assert.notEqual(redacted, value);
  assert.ok(!value.includes(redacted));
  assert.ok(redacted.length <= value.length);
});

test('pack publish refuses to write a zip when a credential is in the packet', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = seedWorkspace(dir);
    write(
      path.join(atrisDir, 'wiki', 'leak.md'),
      '# notes\nsession: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n',
    );
    const zipPath = path.join(dir, 'leak.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'leaky-pack', '--author', 'Ada Lovelace', '--out', zipPath], { cwd: dir });

    assert.equal(publish.status, 1, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.match(publish.stderr, /refusing to publish: found 1 credential-shaped match\b/);
    assert.match(publish.stderr, /atris\/wiki\/leak\.md:2\s+jwt/);
    assert.doesNotMatch(publish.stderr, /dozjgNryP4J3/);
    assert.ok(!fs.existsSync(zipPath), 'no zip may be written when a secret is found');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish --allow-secrets overrides the scan and says so loudly', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = seedWorkspace(dir);
    write(path.join(atrisDir, 'wiki', 'leak.md'), '# notes\napi_key: 9fK2mQ7xL0aZ4bT8vN1sR6\n');
    const zipPath = path.join(dir, 'override.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'override-pack', '--author', 'Ada Lovelace', '--allow-secrets', '--out', zipPath], { cwd: dir });

    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.match(publish.stdout, /WARNING: --allow-secrets is on/);
    assert.ok(fs.existsSync(zipPath));
  } finally {
    cleanupTempDir(dir);
  }
});

// ── preflight and limits ────────────────────────────────────────────────────

test('pack publish --dry-run prints the summary and writes nothing', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const dryRun = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'preflight-pack', '--author', 'Ada Lovelace', '--dry-run'], { cwd: dir });

    assert.equal(dryRun.status, 0, `stdout:\n${dryRun.stdout}\nstderr:\n${dryRun.stderr}`);
    assert.match(dryRun.stdout, /packet preflight-pack 0\.1\.0/);
    assert.match(dryRun.stdout, /files\s+8 \(limit 500\)/);
    assert.match(dryRun.stdout, /unpacked\s+\d/);
    assert.match(dryRun.stdout, /zip\s+\d/);
    assert.match(dryRun.stdout, /atris\/wiki\/page\.md/);
    assert.match(dryRun.stdout, /skipped:/);
    assert.match(dryRun.stdout, /runtime exhaust or dependency \(runs\/\): 1/);
    assert.match(dryRun.stdout, /dry run: nothing written/);

    assert.ok(!fs.existsSync(path.join(dir, 'pack.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'atris', 'pack.json')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish hard-fails and names the registry limit it broke', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = seedWorkspace(dir);
    for (let i = 0; i < REGISTRY_LIMITS.maxEntries + 10; i += 1) {
      write(path.join(atrisDir, 'wiki', `page-${i}.md`), `# page ${i}\n`);
    }
    const zipPath = path.join(dir, 'huge.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'huge-pack', '--author', 'Ada Lovelace', '--out', zipPath], { cwd: dir });

    assert.equal(publish.status, 1, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.match(publish.stderr, /refusing to publish: packet exceeds the registry limits/);
    assert.match(publish.stderr, /entry count: \d+ files exceeds the 500 file registry limit/);
    assert.ok(!fs.existsSync(zipPath));
  } finally {
    cleanupTempDir(dir);
  }
});

test('registryLimitFailures names each limit independently', () => {
  const oneMb = { name: 'a.md', data: Buffer.alloc(REGISTRY_LIMITS.maxUnpackedBytes + 1) };
  assert.deepEqual(registryLimitFailures([], 0), []);
  assert.match(registryLimitFailures([oneMb], 0)[0], /unpacked size/);
  assert.match(registryLimitFailures([], REGISTRY_LIMITS.maxZipBytes + 1)[0], /zip size/);
});

// ── manifest correctness ────────────────────────────────────────────────────

test('pack publish writes pack.json inside the pack dir, never its parent', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'inside-pack'], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'pack.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'pack.json')), 'publishing must not pollute the parent repo');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish --out refuses an empty author, same as --push', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const zipPath = path.join(dir, 'anon.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'anon-pack', '--out', zipPath], { cwd: dir });
    assert.equal(publish.status, 1, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.match(publish.stderr, /registry packs need an author/);
    assert.ok(!fs.existsSync(zipPath));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack publish rejects a slug the web viewer cannot render', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'ab', '--author', 'Ada Lovelace', '--out', path.join(dir, 'short.zip')], { cwd: dir });
    assert.equal(publish.status, 1, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);
    assert.match(publish.stderr, /pack slug "ab" is not viewable on the web/);
    assert.match(publish.stderr, /3-40 characters/);

    const long = 'a'.repeat(41);
    const tooLong = runCli(['pack', 'publish', '--dir', 'atris', '--slug', long, '--author', 'Ada Lovelace', '--out', path.join(dir, 'long.zip')], { cwd: dir });
    assert.equal(tooLong.status, 1);
    assert.match(tooLong.stderr, /is not viewable on the web/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a published packet round trips through install with identical bytes', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = seedWorkspace(dir);
    const zipPath = path.join(dir, 'trip.zip');
    const publish = runCli(['pack', 'publish', '--dir', 'atris', '--slug', 'trip-pack', '--author', 'Ada Lovelace', '--out', zipPath], { cwd: dir });
    assert.equal(publish.status, 0, `stdout:\n${publish.stdout}\nstderr:\n${publish.stderr}`);

    const target = path.join(dir, 'installed');
    const install = runCli(['pack', 'install', zipPath, '--dir', target], { cwd: dir });
    assert.equal(install.status, 0, `stdout:\n${install.stdout}\nstderr:\n${install.stderr}`);

    const shipped = readZipFile(zipPath).map((entry) => entry.name).filter((name) => name !== 'pack.json');
    for (const name of shipped) {
      const installed = fs.readFileSync(path.join(target, name));
      const original = fs.readFileSync(path.join(atrisDir, name.replace(/^atris\//, '')));
      assert.deepEqual(installed, original, `${name} changed in the round trip`);
    }
    assert.ok(fs.existsSync(path.join(target, 'pack.json')));
    assert.ok(!fs.existsSync(path.join(target, 'atris', 'runs')));
  } finally {
    cleanupTempDir(dir);
  }
});
