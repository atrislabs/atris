'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findLocalWikiDir } = require('../lib/wiki');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wiki-dir-'));
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  return root;
}

function cleanupIsolatedEnv(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test('findLocalWikiDir: returns standard atris/wiki path when it exists', () => {
  const root = setupIsolatedEnv();
  try {
    const standardWikiDir = path.join(root, 'atris', 'wiki');
    fs.mkdirSync(standardWikiDir, { recursive: true });

    const result = findLocalWikiDir(root);
    assert.strictEqual(result, standardWikiDir);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('findLocalWikiDir: prefers atris/wiki over legacy wiki and slug paths', () => {
  const root = setupIsolatedEnv();
  try {
    const standardWikiDir = path.join(root, 'atris', 'wiki');
    const legacyWikiDir = path.join(root, 'wiki');
    const slugWikiDir = path.join(root, 'atris', 'my-team', 'wiki');
    fs.mkdirSync(standardWikiDir, { recursive: true });
    fs.mkdirSync(legacyWikiDir, { recursive: true });
    fs.mkdirSync(slugWikiDir, { recursive: true });

    const result = findLocalWikiDir(root, 'my-team');
    assert.strictEqual(result, standardWikiDir);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('findLocalWikiDir: falls back to legacy wiki, then slug paths when standard is absent', () => {
  const root = setupIsolatedEnv();
  try {
    const legacyWikiDir = path.join(root, 'wiki');
    fs.mkdirSync(legacyWikiDir, { recursive: true });

    assert.strictEqual(findLocalWikiDir(root), legacyWikiDir);

    fs.rmdirSync(legacyWikiDir);
    const nestedSlugDir = path.join(root, 'atris', 'proj-a', 'wiki');
    fs.mkdirSync(nestedSlugDir, { recursive: true });
    assert.strictEqual(findLocalWikiDir(root, 'proj-a'), nestedSlugDir);

    const rootSlugDir = path.join(root, 'proj-a', 'wiki');
    fs.mkdirSync(rootSlugDir, { recursive: true });
    assert.strictEqual(findLocalWikiDir(root, 'proj-a'), nestedSlugDir);

    fs.rmdirSync(nestedSlugDir);
    assert.strictEqual(findLocalWikiDir(root, 'proj-a'), rootSlugDir);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('findLocalWikiDir: handles private mode correctly', () => {
  const root = setupIsolatedEnv();
  try {
    const standardWikiDir = path.join(root, 'atris', 'wiki');
    fs.mkdirSync(standardWikiDir, { recursive: true });

    assert.strictEqual(findLocalWikiDir(root, null, 'private'), null);

    const privateDir = path.join(root, '.atris', 'presidio');
    fs.mkdirSync(privateDir, { recursive: true });
    assert.strictEqual(findLocalWikiDir(root, null, 'private'), privateDir);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('findLocalWikiDir: returns null when no candidate directory exists', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(findLocalWikiDir(root), null);
    assert.strictEqual(findLocalWikiDir(root, 'nonexistent-slug'), null);
    assert.strictEqual(findLocalWikiDir(root, 'nonexistent-slug', 'private'), null);
  } finally {
    cleanupIsolatedEnv(root);
  }
});
