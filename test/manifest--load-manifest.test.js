'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadManifest } = require('../lib/manifest');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  const prior = process.env.ATRIS_TEST_STATE_DIR;
  process.env.ATRIS_TEST_STATE_DIR = root;

  t.after(() => {
    if (prior === undefined) delete process.env.ATRIS_TEST_STATE_DIR;
    else process.env.ATRIS_TEST_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });

  return root;
}

test('loadManifest returns parsed json object for existing valid manifest', (t) => {
  const root = createFixture(t);
  const slug = 'acme-corp';
  const manifestDir = path.join(root, '.atris', 'businesses', slug);
  fs.mkdirSync(manifestDir, { recursive: true });

  const manifestData = {
    last_sync: '2026-01-01T12:00:00.000Z',
    last_commit: '1a2b3c4d',
    workspace_root: '/tmp/workspace',
    files: {
      '/src/index.js': {
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size: 120,
      },
    },
  };

  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifestData, null, 2));

  const result = loadManifest(slug);
  assert.deepStrictEqual(result, manifestData);
});

test('loadManifest returns null when manifest file does not exist', (t) => {
  createFixture(t);
  const result = loadManifest('nonexistent-business');
  assert.strictEqual(result, null);
});

test('loadManifest refuses an existing manifest containing invalid json', (t) => {
  const root = createFixture(t);
  const slug = 'broken-business';
  const manifestDir = path.join(root, '.atris', 'businesses', slug);
  fs.mkdirSync(manifestDir, { recursive: true });

  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), '{ invalid json, not parsed:');

  assert.throws(() => loadManifest(slug), /cannot safely parse sync manifest/);
});

test('loadManifest refuses a baseline missing its files map', (t) => {
  const root = createFixture(t);
  const slug = 'empty-business';
  const manifestDir = path.join(root, '.atris', 'businesses', slug);
  fs.mkdirSync(manifestDir, { recursive: true });

  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), '{}');

  assert.throws(() => loadManifest(slug), /manifest files must be an object/);
});
