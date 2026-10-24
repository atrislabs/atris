'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isolated(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-craft-direct-'));
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = dir;
    const { craftPack } = require('../commands/pack');
    run(dir, craftPack);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
}

test('craftPack creates a complete research scaffold using the local author', () => {
  isolated((dir, craftPack) => {
    fs.mkdirSync(path.join(dir, '.atris'));
    fs.writeFileSync(path.join(dir, '.atris', 'credentials.json'),
      JSON.stringify({ email: '  researcher@example.test  ' }));
    const args = ['Ocean Research!', '--dir', 'research folder'];
    assert.strictEqual(craftPack(args, dir), 0);
    assert.deepStrictEqual(args, ['Ocean Research!', '--dir', 'research folder']);
    const target = path.join(dir, 'research folder');
    assert.deepStrictEqual(readManifest(target), {
      name: 'ocean-research', slug: 'ocean-research', title: 'Ocean Research',
      description: 'research pack on Ocean Research!, in progress',
      author: 'researcher@example.test', tags: [], version: '0.0.1', versions: [],
    });
    assert.strictEqual(fs.readFileSync(path.join(target, 'README.md'), 'utf8'),
      '# Ocean Research\n\nresearch pack on Ocean Research!.\n\nrun your agent in this folder.\n');
    assert.strictEqual(fs.readFileSync(path.join(target, 'wiki', 'index.md'), 'utf8'),
      '# wiki index\n\npages: none yet\n');
    assert.strictEqual(fs.readFileSync(path.join(target, 'atris', 'now.md'), 'utf8'),
      'nothing gathered yet. start with the 3 most load-bearing questions about Ocean Research!.\n');
    const boot = fs.readFileSync(path.join(target, 'atris', 'atris.md'), 'utf8');
    assert.match(boot, /you are filling a research pack on Ocean Research!\./);
    assert.match(boot, /never fabricate citations/);
    assert.match(boot, /atris pack publish --push/);
  });
});

test('craftPack falls back for punctuation-only topics and protects existing files', () => {
  isolated((dir, craftPack) => {
    assert.strictEqual(craftPack(['!!!'], dir), 0);
    const target = path.join(dir, 'atris-pack');
    assert.strictEqual(readManifest(target).title, 'Atris Pack');
    assert.strictEqual(readManifest(target).author, 'unknown author');
    fs.writeFileSync(path.join(target, 'README.md'), 'keep this');
    assert.throws(() => craftPack(['!!!'], dir),
      /target is not empty: atris-pack\. rerun with --force to overwrite\./);
    assert.strictEqual(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'keep this');
    fs.writeFileSync(path.join(target, 'notes.txt'), 'unrelated notes');
    assert.strictEqual(craftPack(['Replacement', '--dir=atris-pack', '--force'], dir), 0);
    assert.strictEqual(readManifest(target).slug, 'replacement');
    assert.match(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), /^# Replacement\n/);
    assert.strictEqual(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'unrelated notes');
  });
});

test('craftPack returns help for empty input and rejects invalid arguments without writing', () => {
  isolated((dir, craftPack) => {
    for (const args of [[], [''], ['help'], ['--help'], ['-h']]) {
      assert.deepStrictEqual(craftPack(args, dir), { needsHelp: true });
    }
    assert.throws(() => craftPack(['topic', '--dir'], dir), /--dir requires a value/);
    assert.throws(() => craftPack(['topic', '--unexpected'], dir),
      /unknown pack craft argument: --unexpected/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });
});
