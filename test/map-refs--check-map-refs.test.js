'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkMapRefs } = require('../lib/map-refs');

function fixture(t, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-map-refs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (lines) fs.writeFileSync(path.join(root, 'source.js'), lines.join('\n'));
  return root;
}

test('checkMapRefs accepts nearby symbols and reports parsed reference locations', (t) => {
  const root = fixture(t, ['// intro', 'function readValue() {}', '// end']);
  const result = checkMapRefs(root, '# map\n`source.js:1` `readValue`\n`./source.js:2-3`');

  assert.deepStrictEqual(result, {
    total: 2, ok: 2, moved: 0, ambiguous: 0, missing: 0, missing_file: 0,
    score: 1,
    refs: [
      { map_line: 2, column: 0, raw: 'source.js:1', path: 'source.js',
        start: 1, end: null, extra: [], symbols: ['readValue'], symbol: 'readValue', status: 'ok' },
      { map_line: 3, column: 0, raw: './source.js:2-3', path: 'source.js',
        start: 2, end: 3, extra: [], symbols: [], symbol: null, status: 'ok' },
    ],
  });
});

test('checkMapRefs finds moved definitions and clamps a moved range to the file end', (t) => {
  const root = fixture(t, [
    'readValue();', '// filler', '// filler', '// filler', '// filler',
    '// filler', '// filler', 'function readValue() {}', '// end',
  ]);
  const result = checkMapRefs(root, '`source.js:20-22` `readValue`');

  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.moved, 1);
  assert.strictEqual(result.score, 0);
  assert.strictEqual(result.refs[0].status, 'moved');
  assert.strictEqual(result.refs[0].line, 8);
  assert.strictEqual(result.refs[0].end_line, 9);
});

test('checkMapRefs distinguishes ambiguous symbols, missing symbols, invalid lines and files', (t) => {
  const root = fixture(t, [
    'function duplicate() {}', 'function duplicate() {}', '// filler', '// filler',
    '// filler', '// filler', '// filler', '// filler', '// end',
  ]);
  const result = checkMapRefs(root, [
    '`source.js:9` `duplicate`',
    '`source.js:1` `absent`',
    '`source.js:0`',
    '`source.js:1-10`',
    '`missing.js:1`',
  ].join('\n'));

  const { refs, ...summary } = result;
  assert.deepStrictEqual(summary, {
    total: 5, ok: 0, moved: 0, ambiguous: 1, missing: 3, missing_file: 1, score: 0,
  });
  assert.deepStrictEqual(refs.map(ref => ref.status), [
    'ambiguous', 'missing', 'missing', 'missing', 'missing-file',
  ]);
  assert.deepStrictEqual(refs[0].lines, [1, 2]);
  assert.strictEqual(refs[1].reason, 'absent is not in the file');
  assert.strictEqual(refs[2].reason, 'line out of range');
  assert.strictEqual(refs[3].reason, 'line out of range');
});

test('checkMapRefs returns a perfect empty summary for empty text or non-reference prose', (t) => {
  const root = fixture(t);
  for (const text of ['', 'See source.js:1, `word:2`, and `https://example.com:3`.']) {
    assert.deepStrictEqual(checkMapRefs(root, text), {
      total: 0, ok: 0, moved: 0, ambiguous: 0, missing: 0, missing_file: 0,
      score: 1, refs: [],
    });
  }
});
