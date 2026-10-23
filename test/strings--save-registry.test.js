const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveRegistry, loadRegistry } = require('../commands/strings');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-strings-save-'));
}

function sampleRegistry() {
  return {
    version: 1,
    scannedAt: '2026-01-02T03:04:05.000Z',
    root: 'app',
    strings: [
      { text: 'Add to cart', norm: 'add to cart', count: 2, locations: [{ file: 'a.js', line: 3 }] },
    ],
    terms: [{ ban: 'live', prefer: 'active', why: 'one word for one state' }],
  };
}

test('saveRegistry writes pretty JSON with a trailing newline and returns the file path', () => {
  const root = makeRoot();
  try {
    const reg = sampleRegistry();
    const file = saveRegistry(reg, root);

    assert.strictEqual(file, path.join(root, '.atris', 'strings.json'));
    const raw = fs.readFileSync(file, 'utf8');
    assert.strictEqual(raw, JSON.stringify(reg, null, 2) + '\n');
    assert.ok(raw.endsWith('}\n'));
    assert.ok(raw.includes('\n  "version": 1,'), 'two-space indent');
    assert.deepStrictEqual(JSON.parse(raw), reg);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRegistry creates the .atris folder when it is missing, and reuses it when present', () => {
  const root = makeRoot();
  try {
    assert.ok(!fs.existsSync(path.join(root, '.atris')));
    saveRegistry({ version: 1, strings: [], terms: [] }, root);
    assert.ok(fs.statSync(path.join(root, '.atris')).isDirectory());

    // second call with the .atris folder already there must not throw
    fs.writeFileSync(path.join(root, '.atris', 'other.txt'), 'keep me');
    const file = saveRegistry({ version: 1, strings: [], terms: [] }, root);
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.readFileSync(path.join(root, '.atris', 'other.txt'), 'utf8'), 'keep me');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRegistry creates a root folder that does not exist yet', () => {
  const base = makeRoot();
  try {
    const root = path.join(base, 'deep', 'nested', 'project');
    const file = saveRegistry({ version: 1, strings: [], terms: [] }, root);
    assert.strictEqual(file, path.join(root, '.atris', 'strings.json'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, strings: [], terms: [] });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('saveRegistry overwrites an earlier registry instead of appending', () => {
  const root = makeRoot();
  try {
    saveRegistry(sampleRegistry(), root);
    const second = { version: 1, scannedAt: null, root: null, strings: [], terms: [] };
    const file = saveRegistry(second, root);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(second, null, 2) + '\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRegistry output round-trips through loadRegistry, including unicode text', () => {
  const root = makeRoot();
  try {
    const reg = sampleRegistry();
    reg.strings.push({ text: 'Loading…', norm: 'loading', count: 1, locations: [] });
    reg.strings.push({ text: 'Café "quoted" \\ slash', norm: 'café "quoted" \\ slash', count: 1, locations: [] });
    saveRegistry(reg, root);
    assert.deepStrictEqual(loadRegistry(root), reg);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRegistry writes an empty registry object as {}', () => {
  const root = makeRoot();
  try {
    const file = saveRegistry({}, root);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRegistry defaults the root to the current working directory', () => {
  const root = makeRoot();
  const original = process.cwd();
  try {
    process.chdir(root);
    const expected = path.join(process.cwd(), '.atris', 'strings.json');
    const file = saveRegistry({ version: 1, strings: [], terms: [] });
    assert.strictEqual(file, expected);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(expected, 'utf8')), { version: 1, strings: [], terms: [] });
  } finally {
    process.chdir(original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveRegistry throws when the root is a file, not a folder', () => {
  const base = makeRoot();
  try {
    const notAFolder = path.join(base, 'plain-file');
    fs.writeFileSync(notAFolder, 'x');
    assert.throws(() => saveRegistry(sampleRegistry(), notAFolder), (err) => err instanceof Error && typeof err.code === 'string');
    assert.strictEqual(fs.readFileSync(notAFolder, 'utf8'), 'x', 'the file is left untouched');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('saveRegistry throws on a registry JSON cannot serialize and writes nothing', () => {
  const root = makeRoot();
  try {
    const circular = {};
    circular.self = circular;
    assert.throws(() => saveRegistry(circular, root), TypeError);
    assert.ok(!fs.existsSync(path.join(root, '.atris', 'strings.json')), 'no half-written file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
