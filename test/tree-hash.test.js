'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  TREE_HASH_SCHEMA,
  computeTreeHash,
  treeHashFor,
} = require('../lib/tree-hash');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tree-hash-test-'));
}

function writeFile(root, relativePath, contents) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test('tree hash is deterministic and sorts its manifest by relative path', () => {
  const root = makeTempDir();
  try {
    writeFile(root, 'atris/team/validator/MEMBER.md', 'validator\n');
    writeFile(root, 'atris.md', 'root\n');
    writeFile(root, 'atris/skills/writer/SKILL.md', 'writer\n');
    const first = computeTreeHash(root);
    const second = computeTreeHash(root);
    assert.deepEqual(second, first);
    assert.deepEqual(first.manifest.map((file) => file.path), [
      'atris.md',
      'atris/skills/writer/SKILL.md',
      'atris/team/validator/MEMBER.md',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tree hash changes after a one-byte skill edit', () => {
  const root = makeTempDir();
  try {
    writeFile(root, 'atris/skills/writer/SKILL.md', 'a');
    const before = computeTreeHash(root).hash;
    writeFile(root, 'atris/skills/writer/SKILL.md', 'b');
    assert.notEqual(computeTreeHash(root).hash, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tree hash ignores files outside the agent text tree', () => {
  const root = makeTempDir();
  try {
    writeFile(root, 'atris.md', 'root\n');
    const before = computeTreeHash(root).hash;
    writeFile(root, 'lib/foo.js', 'changed\n');
    writeFile(root, 'atris/TODO.md', 'changed\n');
    assert.equal(computeTreeHash(root).hash, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tree hash tolerates missing optional files and unreadable roots', () => {
  const root = makeTempDir();
  try {
    const result = computeTreeHash(root);
    assert.equal(result.schema, TREE_HASH_SCHEMA);
    assert.equal(result.files, 0);
    assert.deepEqual(result.manifest, []);
    assert.equal(treeHashFor(path.join(root, 'missing')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atris tree hash --json prints the full tree hash object', () => {
  const root = makeTempDir();
  try {
    writeFile(root, 'atris.md', 'cli tree\n');
    const result = spawnSync(process.execPath, [cliPath, 'tree', 'hash', '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, TREE_HASH_SCHEMA);
    assert.equal(payload.files, 1);
    assert.equal(payload.short, payload.hash.slice(0, 12));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
