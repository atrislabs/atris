const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const {
  analyzeBusinessDoctor,
  isAccidentalHelpBusiness,
  validateBusinessCreateName,
} = require('../commands/business');
const { isJunkBusiness } = require('../scripts/cleanup-accidental-help-businesses');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-create-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(env || {}),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
}

test('validateBusinessCreateName rejects help tokens and flag-shaped names', () => {
  for (const bad of ['--help', '-h', 'help', '-?', '--description', '']) {
    const result = validateBusinessCreateName(bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.match(result.usage, /Usage: atris business create/);
  }

  const flag = validateBusinessCreateName('--workspace');
  assert.equal(flag.ok, false);
  assert.match(flag.detail, /looks like a flag/);

  const ok = validateBusinessCreateName('Acme Co');
  assert.equal(ok.ok, true);
});

test('isAccidentalHelpBusiness matches April ghost rows', () => {
  assert.equal(isAccidentalHelpBusiness('--help'), true);
  assert.equal(isAccidentalHelpBusiness('help'), true);
  assert.equal(isAccidentalHelpBusiness('help-1'), true);
  assert.equal(isAccidentalHelpBusiness('help-3'), true);
  assert.equal(isAccidentalHelpBusiness('Help Desk'), false);
  assert.equal(isAccidentalHelpBusiness('acme-co'), false);
});

test('business doctor flags accidental help cloud rows and cache keys', () => {
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [
      { id: 'ghost-1', slug: 'help', name: '--help' },
      { id: 'ghost-2', slug: 'help-1', name: 'help-1' },
      { id: 'real-1', slug: 'acme', name: 'Acme Co' },
    ],
    cache: {
      help: { business_id: 'ghost-1', slug: 'help', name: '--help' },
      acme: { business_id: 'real-1', slug: 'acme', name: 'Acme Co' },
    },
    folderBindings: [],
  });

  assert.ok(analysis.issues.some((issue) => issue.code === 'accidental-help-business'));
  assert.ok(analysis.issues.some((issue) => issue.code === 'accidental-help-cache'));
  assert.deepEqual(analysis.cacheRemovals, ['help']);
});

test('cleanup script shares junk detector with business doctor', () => {
  assert.equal(isJunkBusiness({ name: '--help', slug: 'help' }), true);
  assert.equal(isJunkBusiness({ name: 'Acme Co', slug: 'acme' }), false);
});

test('business init --help prints usage without creating a business', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  try {
    const res = runCli(['business', 'init', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris business/);
    assert.match(res.stdout, /init <name>/);
    assert.doesNotMatch(res.stdout + res.stderr, /Creating business/);
    assert.equal(fs.existsSync(path.join(home, '.atris', 'businesses.json')), false);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('business create --help and flag-only create refuse before login', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  try {
    for (const args of [['business', 'create', '--help'], ['business', 'create', '-h']]) {
      const res = runCli(args, { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris business/);
      assert.doesNotMatch(res.stdout + res.stderr, /Creating business/);
    }

    const flagOnly = runCli(['business', 'create', '--workspace'], { cwd: dir, env: { HOME: home } });
    assert.notEqual(flagOnly.status, 0);
    assert.match(flagOnly.stderr, /looks like a flag/);
    assert.doesNotMatch(flagOnly.stdout + flagOnly.stderr, /Creating business/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});
