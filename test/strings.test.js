const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isUserFacing, extractStrings, normalize, variantClusters,
  scan, variants, term, check, loadRegistry,
} = require('../commands/strings');

test('isUserFacing keeps real labels, rejects code/classes/identifiers', () => {
  // user-facing (quoted phrases require >= 2 words)
  assert.ok(isUserFacing('Add to cart', 2));
  assert.ok(isUserFacing('Are you sure?', 2));
  assert.ok(isUserFacing('Settings', 1)); // single-word JSX label
  // not user-facing
  assert.ok(!isUserFacing('flex items-center gap-2', 2), 'tailwind classes');
  assert.ok(!isUserFacing('text-sm font-medium', 2), 'class list');
  assert.ok(!isUserFacing('./components/Button', 2), 'path');
  assert.ok(!isUserFacing('https://atris.ai', 2), 'url');
  assert.ok(!isUserFacing('#6366f1', 2), 'hex color');
  assert.ok(!isUserFacing('MAX_RETRIES', 2), 'CONSTANT_CASE');
  assert.ok(!isUserFacing('userId', 1), 'identifier (single lowercase token)');
  assert.ok(!isUserFacing('count > 0', 2), 'code operator');
});

test('extractStrings pulls JSX text + quoted phrases, skips classNames', () => {
  const src = [
    '<button className="flex items-center gap-2" title="Save changes">Delete item</button>',
    'const msg = "You have unsaved work";',
    'import Button from "./Button";',
  ].join('\n');
  const texts = extractStrings(src).map((h) => h.text);
  assert.ok(texts.includes('Delete item'), 'jsx text node');
  assert.ok(texts.includes('Save changes'), 'attribute phrase');
  assert.ok(texts.includes('You have unsaved work'), 'string literal');
  assert.ok(!texts.includes('flex items-center gap-2'), 'classNames excluded');
  assert.ok(!texts.some((t) => t.includes('./Button')), 'import path excluded');
});

test('normalize folds casing / punctuation / spacing', () => {
  assert.equal(normalize('Delete item.'), normalize('delete  item'));
  assert.equal(normalize('Save Changes'), normalize('save changes'));
  assert.notEqual(normalize('Delete item'), normalize('Remove item'), 'different words stay distinct');
});

test('variantClusters flags the same string written multiple ways', () => {
  const strings = [
    { text: 'Delete item', norm: normalize('Delete item'), count: 3 },
    { text: 'delete item', norm: normalize('delete item'), count: 2 },
    { text: 'Save changes', norm: normalize('Save changes'), count: 5 },
  ];
  const clusters = variantClusters(strings);
  assert.equal(clusters.length, 1, 'only the inconsistent one clusters');
  assert.deepEqual(clusters[0].surfaces.sort(), ['Delete item', 'delete item']);
  assert.equal(clusters[0].count, 5);
});

test('scan -> variants -> term -> check round trip (path mode)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-strings-'));
  fs.writeFileSync(path.join(dir, 'a.tsx'), '<p>Delete item</p>\n<span title="delete item">x</span>\n');
  fs.writeFileSync(path.join(dir, 'b.tsx'), '<button>Add to blacklist</button>\n');
  const cwd = process.cwd();
  const log = console.log; console.log = () => {}; // silence command chatter
  try {
    process.chdir(dir);
    assert.equal(scan(['.']), 0);
    const reg = loadRegistry();
    assert.ok(reg.strings.some((s) => s.text === 'Delete item'));

    assert.equal(variants([]), 1, 'casing variant detected -> exit 1');

    assert.equal(term(['--ban', 'blacklist', '--prefer', 'blocklist']), 0);
    assert.equal(loadRegistry().terms.length, 1);

    assert.equal(check(['.']), 1, 'banned term present -> exit 1');
    fs.writeFileSync(path.join(dir, 'b.tsx'), '<button>Add to blocklist</button>\n');
    assert.equal(check(['.']), 0, 'after fix -> clean');
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
