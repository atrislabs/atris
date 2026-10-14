'use strict';

// A ref that names a function the file defines must sit on that definition.
// A call a few lines from the old line used to pass, which hid a 17-line
// drift to checkPageStaleness in commands/clean.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkMapRefs } = require('../lib/map-refs');

const CODE = [
  "'use strict';",               // 1
  '',                            // 2
  'function scan(dir) {',        // 3
  '  const out = [];',           // 4
  '  out.push(check(dir));',     // 5  call to check
  '  return out;',               // 6
  '}',                           // 7
  '',                            // 8
  '',                            // 9
  'function check(dir) {',       // 10 definition of check
  '  return dir;',               // 11
  '}',                           // 12
  '',                            // 13
  'helper(1);',                  // 14 call to a name defined elsewhere
  '',                            // 15
  'module.exports = { scan, check };',
].join('\n');

function refsFor(mapLines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-refs-def-'));
  try {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'code.js'), CODE);
    return checkMapRefs(root, mapLines.join('\n')).refs;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a call near the old line does not hide a moved definition', () => {
  const [ref] = refsFor(['- `check()` (`lib/code.js:4`): checks one folder']);
  assert.equal(ref.status, 'moved');
  assert.equal(ref.line, 10);
});

test('a ref on the definition stays right', () => {
  const [ref] = refsFor(['- `check()` (`lib/code.js:10`): checks one folder']);
  assert.equal(ref.status, 'ok');
});

test('a ref to a call of a name defined elsewhere still matches the call', () => {
  const [ref] = refsFor(['- `lib/code.js:13` `helper` runs the shared helper']);
  assert.equal(ref.status, 'ok');
});
