'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PROJECT_THEME_FILE } = require('../lib/theme');

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('a normal project root resolves the theme file under .atris', () => {
  const root = makeRoot('atris-theme-file-');
  try {
    assert.deepStrictEqual(PROJECT_THEME_FILE.split(path.sep), ['.atris', 'theme.json']);
    assert.strictEqual(path.isAbsolute(PROJECT_THEME_FILE), false);

    const file = path.join(root, PROJECT_THEME_FILE);
    assert.strictEqual(path.relative(root, file), PROJECT_THEME_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"name":"brand"}\n');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"name":"brand"}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('odd folder names still keep the theme file nested inside .atris', () => {
  const base = makeRoot('atris-theme-edge-');
  try {
    const roots = [
      path.join(base, 'name with spaces'),
      path.join(base, '.hidden'),
      path.join(base, '.atris'),
    ];
    for (const root of roots) {
      fs.mkdirSync(root, { recursive: true });
      const direct = path.join(root, PROJECT_THEME_FILE);
      const trailing = path.join(root + path.sep, PROJECT_THEME_FILE);
      assert.strictEqual(trailing, direct);
      assert.strictEqual(path.relative(root, direct), PROJECT_THEME_FILE);
      assert.strictEqual(path.basename(direct), 'theme.json');
      assert.strictEqual(path.basename(path.dirname(direct)), '.atris');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an empty root stays relative and a missing theme file errors', () => {
  assert.strictEqual(PROJECT_THEME_FILE.length > 0, true);
  assert.strictEqual(path.join('', PROJECT_THEME_FILE), PROJECT_THEME_FILE);
  assert.strictEqual(path.join(PROJECT_THEME_FILE, ''), PROJECT_THEME_FILE);
  assert.strictEqual(path.parse(PROJECT_THEME_FILE).root, '');

  const root = makeRoot('atris-theme-empty-');
  try {
    const file = path.join(root, PROJECT_THEME_FILE);
    assert.strictEqual(fs.existsSync(file), false);
    assert.throws(() => fs.readFileSync(file, 'utf8'), { code: 'ENOENT' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
