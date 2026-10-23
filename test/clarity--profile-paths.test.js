'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { profilePaths } = require('../lib/clarity');

function withIsolatedEnv(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clarity-paths-'));
  const prevHome = process.env.HOME;
  const savedAtrisEnvs = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedAtrisEnvs[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.HOME = root;
  try {
    fn(root);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const [key, val] of Object.entries(savedAtrisEnvs)) {
      process.env[key] = val;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

test('profilePaths returns expected json and md paths for an explicit root directory', () => {
  withIsolatedEnv((root) => {
    const paths = profilePaths(root);

    assert.strictEqual(typeof paths, 'object');
    assert.notStrictEqual(paths, null);
    assert.strictEqual(paths.json, path.join(root, '.atris', 'clarity.json'));
    assert.strictEqual(paths.md, path.join(root, 'atris', 'CLARITY.md'));

    fs.mkdirSync(path.dirname(paths.json), { recursive: true });
    fs.mkdirSync(path.dirname(paths.md), { recursive: true });
    fs.writeFileSync(paths.json, '{"focus":"test"}\n', 'utf8');
    fs.writeFileSync(paths.md, '# Clarity\n', 'utf8');

    assert.strictEqual(fs.existsSync(paths.json), true);
    assert.strictEqual(fs.existsSync(paths.md), true);
    assert.strictEqual(fs.readFileSync(paths.json, 'utf8'), '{"focus":"test"}\n');
  });
});

test('profilePaths defaults to process.cwd() when root is omitted or undefined', () => {
  withIsolatedEnv(() => {
    const defaultPaths = profilePaths();
    assert.strictEqual(defaultPaths.json, path.join(process.cwd(), '.atris', 'clarity.json'));
    assert.strictEqual(defaultPaths.md, path.join(process.cwd(), 'atris', 'CLARITY.md'));

    const explicitUndefined = profilePaths(undefined);
    assert.strictEqual(explicitUndefined.json, path.join(process.cwd(), '.atris', 'clarity.json'));
    assert.strictEqual(explicitUndefined.md, path.join(process.cwd(), 'atris', 'CLARITY.md'));
  });
});

test('profilePaths handles edge cases such as trailing slashes, relative paths, and empty strings', () => {
  withIsolatedEnv((root) => {
    const rootWithSlash = root + path.sep;
    const pathsFromSlash = profilePaths(rootWithSlash);
    assert.strictEqual(pathsFromSlash.json, path.join(root, '.atris', 'clarity.json'));
    assert.strictEqual(pathsFromSlash.md, path.join(root, 'atris', 'CLARITY.md'));

    const relativePaths = profilePaths('.');
    assert.strictEqual(relativePaths.json, path.join('.', '.atris', 'clarity.json'));
    assert.strictEqual(relativePaths.md, path.join('.', 'atris', 'CLARITY.md'));

    const nestedRelative = profilePaths(path.join('sub', 'repo'));
    assert.strictEqual(nestedRelative.json, path.join('sub', 'repo', '.atris', 'clarity.json'));
    assert.strictEqual(nestedRelative.md, path.join('sub', 'repo', 'atris', 'CLARITY.md'));

    const emptyPaths = profilePaths('');
    assert.strictEqual(emptyPaths.json, path.join('', '.atris', 'clarity.json'));
    assert.strictEqual(emptyPaths.md, path.join('', 'atris', 'CLARITY.md'));
  });
});

test('profilePaths rejects invalid root types with TypeError', () => {
  withIsolatedEnv(() => {
    assert.throws(() => profilePaths(null), TypeError);
    assert.throws(() => profilePaths(123), TypeError);
    assert.throws(() => profilePaths(true), TypeError);
    assert.throws(() => profilePaths({}), TypeError);
  });
});
