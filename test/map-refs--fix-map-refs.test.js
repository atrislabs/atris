'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixMapRefs, checkMapRefs } = require('../lib/map-refs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fix-map-refs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(name, text) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    read(name) { return fs.readFileSync(path.join(root, name), 'utf8'); },
  };
}

test('fixMapRefs pins multiple references on one line to their names and is idempotent', t => {
  const f = fixture(t);
  const source = Array(14).fill('// padding');
  source[9] = 'function firstHelper() {}';
  source[13] = 'const secondHelper = () => {};';
  f.write('src/helpers.js', source.join('\n'));
  f.write('atris/MAP.md', '# Helpers\nSee `src/helpers.js:1` `firstHelper` and `src/helpers.js:2` `secondHelper`.\n');

  assert.deepStrictEqual(fixMapRefs(f.root), {
    changes: [
      { map_line: 2, from: 'src/helpers.js:1', to: 'src/helpers.js', symbol: 'firstHelper' },
      { map_line: 2, from: 'src/helpers.js:2', to: 'src/helpers.js', symbol: 'secondHelper' },
    ],
    left: [],
  });
  const expected = '# Helpers\nSee `src/helpers.js` `firstHelper` and `src/helpers.js` `secondHelper`.\n';
  assert.strictEqual(f.read('atris/MAP.md'), expected);
  assert.deepStrictEqual(fixMapRefs(f.root), { changes: [], left: [] });
  assert.strictEqual(f.read('atris/MAP.md'), expected);
});

test('fixMapRefs drops a moved range and its anchor and keeps the line endings', t => {
  const f = fixture(t);
  f.write('src/end.js', Array(7).fill('// padding').concat('function endHelper() {}').join('\n'));
  f.write('docs/routes.md', 'Routes\r\n`./src/end.js:1-4#details` (`endHelper`)\r\n');

  assert.deepStrictEqual(fixMapRefs(f.root, 'docs/routes.md'), {
    changes: [{ map_line: 2, from: './src/end.js:1-4#details', to: './src/end.js', symbol: 'endHelper' }],
    left: [],
  });
  assert.strictEqual(f.read('docs/routes.md'), 'Routes\r\n`./src/end.js` (`endHelper`)\r\n');
  assert.deepStrictEqual(fixMapRefs(f.root, 'docs/routes.md'), { changes: [], left: [] });
});

test('fixMapRefs leaves ambiguous, absent, and out-of-range references unchanged', t => {
  const f = fixture(t);
  const source = Array(12).fill('// padding');
  source[7] = 'function duplicate() {}';
  source[11] = 'function duplicate() {}';
  f.write('src/helpers.js', source.join('\n'));
  const original = [
    '`src/helpers.js:1` `duplicate`',
    '`src/helpers.js:1` `absentHelper`',
    '`src/missing.js:1`',
    '`src/helpers.js:99`',
    '`src/helpers.js:8`',
  ].join('\n');
  f.write('atris/MAP.md', original);

  const result = fixMapRefs(f.root);
  assert.deepStrictEqual(result.changes, []);
  assert.deepStrictEqual(result.left.map(ref => [ref.raw, ref.status]), [
    ['src/helpers.js:1', 'ambiguous'],
    ['src/helpers.js:1', 'missing'],
    ['src/missing.js:1', 'missing-file'],
    ['src/helpers.js:99', 'missing'],
  ]);
  assert.deepStrictEqual(result.left[0].lines, [8, 12]);
  assert.strictEqual(result.left[1].reason, 'absentHelper is not in the file');
  assert.strictEqual(result.left[3].reason, 'line out of range');
  assert.strictEqual(f.read('atris/MAP.md'), original);
});

test('fixMapRefs handles an empty map and reports a missing map', t => {
  const f = fixture(t);
  f.write('atris/MAP.md', '');
  assert.deepStrictEqual(fixMapRefs(f.root), { changes: [], left: [] });
  assert.strictEqual(f.read('atris/MAP.md'), '');
  assert.throws(() => fixMapRefs(f.root, 'missing.md'), { code: 'ENOENT' });
  assert.strictEqual(fs.existsSync(path.join(f.root, 'missing.md')), false);
});

// A ref to a file the named parser does not read (go, rust, and so on) must keep
// its line number. Dropping it would turn the ref into plain text that no check
// sees, so deleting that code would no longer be noticed.
test('fixMapRefs keeps line refs to other file types checked, and still moves them', t => {
  const f = fixture(t);
  f.write('cmd/server.go', ['package main', '', 'import "net/http"', '', 'func HandleRequest(w http.ResponseWriter, r *http.Request) {}'].join('\n'));
  f.write('src/config.rs', 'pub fn parse_config() {}\n');
  f.write('atris/MAP.md', '- `cmd/server.go:1` `HandleRequest` serves.\n- `src/config.rs:1` (`parse_config`) reads.\n');

  assert.deepStrictEqual(checkMapRefs(f.root, f.read('atris/MAP.md')).total, 2);
  const result = fixMapRefs(f.root);
  assert.deepStrictEqual(result.changes, [
    { map_line: 1, from: 'cmd/server.go:1', to: 'cmd/server.go:5', symbol: 'HandleRequest' },
  ]);
  const expected = '- `cmd/server.go:5` `HandleRequest` serves.\n- `src/config.rs:1` (`parse_config`) reads.\n';
  assert.strictEqual(f.read('atris/MAP.md'), expected);
  const after = checkMapRefs(f.root, expected);
  assert.deepStrictEqual([after.total, after.ok], [2, 2]);

  fs.rmSync(path.join(f.root, 'cmd/server.go'));
  fs.rmSync(path.join(f.root, 'src/config.rs'));
  const gone = checkMapRefs(f.root, expected);
  assert.deepStrictEqual([gone.total, gone.missing_file], [2, 2]);
});
