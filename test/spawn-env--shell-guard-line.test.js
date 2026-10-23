'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shellGuardLine } = require('../lib/spawn-env');

function createTempDir(prefix = 'shell-guard-line-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanEnv(tempHome) {
  process.env.HOME = tempHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
}

test('shellGuardLine generates export PATH line for guarded environment', () => {
  const dir = createTempDir('guard-normal-');
  cleanEnv(dir);
  try {
    const guardDir = path.join(dir, 'atris-mission-git-worker1');
    const normalDir = path.join(dir, 'bin');
    const env = { PATH: [normalDir, guardDir, '/usr/bin'].join(path.delimiter) };

    const line = shellGuardLine(env);
    assert.strictEqual(line, `export PATH='${guardDir}':"$PATH"\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shellGuardLine handles multiple guards and quotes in directory names', () => {
  const dir = createTempDir('guard-edge-');
  cleanEnv(dir);
  try {
    const guard1 = path.join(dir, 'atris-mission-git-first');
    const guardWithQuote = path.join(dir, "atris-mission-git-user's-lane");
    const regularDir = path.join(dir, 'regular-atris-mission-git-tail');

    const env = {
      PATH: [guard1, regularDir, guardWithQuote, '/bin'].join(path.delimiter),
    };

    const escapedQuote = guardWithQuote.replace(/'/g, `'\\''`);
    const line = shellGuardLine(env);
    assert.strictEqual(
      line,
      `export PATH='${guard1}':'${escapedQuote}':"$PATH"\n`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shellGuardLine returns empty string when no guard directories exist or input is empty', () => {
  const dir = createTempDir('guard-empty-');
  cleanEnv(dir);
  try {
    assert.strictEqual(shellGuardLine({ PATH: '/usr/bin:/bin' }), '');
    assert.strictEqual(shellGuardLine({ PATH: '' }), '');
    assert.strictEqual(shellGuardLine({ PATH: null }), '');
    assert.strictEqual(shellGuardLine({ PATH: undefined }), '');
    assert.strictEqual(shellGuardLine({}), '');

    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      assert.strictEqual(shellGuardLine(), '');
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
