const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-show-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function writePack(dir, manifest, files = {}) {
  write(path.join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, contents] of Object.entries(files)) write(path.join(dir, name), contents);
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function outputLines(result) {
  return result.stdout.trim().split('\n');
}

test('pack show gives a ready student one eight-line card and one next move', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'student-proof-pack');
    const runContents = '# Student workflow proof\n';
    const verifyContents = '# Check the student workflow proof\n';
    writePack(packDir, {
      slug: 'student-proof-pack',
      title: 'Student Proof Pack',
      description: 'A student workflow proof.',
      version: '1.0.0',
      type: 'workflow',
      entrypoint: 'RUN.md',
      verifier: 'VERIFY.md',
      permissions: ['pack.read'],
      author: 'Atris',
      provenance: { 'created-in': 'pack show test' },
      origin: { type: 'registry', slug: 'student-proof-pack' },
      'content-hashes': {
        'RUN.md': sha256(runContents),
        'VERIFY.md': sha256(verifyContents),
      },
    }, {
      'RUN.md': runContents,
      'VERIFY.md': verifyContents,
    });
    write(path.join(packDir, '.atris', 'state', 'pack.json'), `${JSON.stringify({
      slug: 'student-proof-pack',
      remoteVersion: '1.0.0',
      lastRemoteCheckAt: '2026-08-02T14:00:00.000Z',
    }, null, 2)}\n`);

    const shown = runCli(['pack', 'show', packDir], dir);
    assert.equal(shown.status, 0, `stdout:\n${shown.stdout}\nstderr:\n${shown.stderr}`);
    assert.deepEqual(outputLines(shown), [
      'Student Proof Pack',
      'what: A student workflow proof.',
      'status: ready to review',
      `where: ${fs.realpathSync(packDir)}`,
      'source: downloaded by Atris from the registry; update: current',
      'access: reads this pack only',
      'check: VERIFY.md is available; not run',
      `next: atris pack run ${fs.realpathSync(packDir)}`,
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack show turns a rejected pack into one plain reason and one student move', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'bilbaoinspiration');
    writePack(packDir, {
      slug: 'bilbaoinspiration',
      title: 'Bilbao Inspiration',
      description: 'A nice Bilbao inspiration list.',
      version: '0.1.0',
      origin: { type: 'file' },
    }, {
      'post.md': '# A generic product announcement\n',
    });

    const shown = runCli(['pack', 'show', packDir], dir);
    assert.equal(shown.status, 0, `stdout:\n${shown.stdout}\nstderr:\n${shown.stderr}`);
    assert.deepEqual(outputLines(shown), [
      'Bilbao Inspiration',
      'what: A nice Bilbao inspiration list.',
      'status: not ready',
      'why: its files do not obviously match its description',
      `where: ${fs.realpathSync(packDir)}`,
      'source: installed from a local file; updates unavailable',
      'access: not declared',
      'next: ask the author to fix this pack before you run it',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack show calls an incomplete legacy pack setup work, not ready', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'legacy-notes');
    writePack(packDir, {
      slug: 'legacy-notes',
      title: 'Legacy Notes',
      version: '0.1.0',
    }, {
      'notes.md': '# Useful notes\n',
    });

    const shown = runCli(['pack', 'show', packDir], dir);
    assert.equal(shown.status, 0, `stdout:\n${shown.stdout}\nstderr:\n${shown.stderr}`);
    assert.deepEqual(outputLines(shown), [
      'Legacy Notes',
      'what: no description provided',
      'status: needs setup',
      'why: it has not declared what kind of pack it is',
      `where: ${fs.realpathSync(packDir)}`,
      'source: local folder; updates unavailable',
      'access: not declared',
      'next: ask the author to finish setting up this pack',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack show does not call a pack ready when its declared check is missing', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'missing-check');
    const runContents = '# Checked workflow\n';
    writePack(packDir, {
      slug: 'missing-check',
      title: 'Missing Check',
      description: 'A checked workflow.',
      version: '1.0.0',
      type: 'workflow',
      entrypoint: 'RUN.md',
      verifier: 'VERIFY.md',
      permissions: ['pack.read'],
      author: 'Atris',
      provenance: { 'created-in': 'pack show test' },
      'content-hashes': { 'RUN.md': sha256(runContents) },
    }, {
      'RUN.md': runContents,
    });

    const shown = runCli(['pack', 'show', packDir], dir);
    assert.equal(shown.status, 0, `stdout:\n${shown.stdout}\nstderr:\n${shown.stderr}`);
    assert.deepEqual(outputLines(shown), [
      'Missing Check',
      'what: A checked workflow.',
      'status: needs setup',
      'why: its declared check cannot be used',
      `where: ${fs.realpathSync(packDir)}`,
      'source: local folder; updates unavailable',
      'access: reads this pack only',
      'next: ask the author to finish setting up this pack',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});
