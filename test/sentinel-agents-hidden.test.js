'use strict';

// sentinel agents, invisible characters: direction controls and tag
// characters always count; a lone zero-width space does not.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agents = require('../lib/sentinel-agents');

function hiddenLines(text) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-hidden-')));
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), text);
    return agents.runAgentCheck(root, {}).findings.filter((f) => f.rule === 'hidden-characters').map((f) => f.line);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('one zero-width space quoted in a note is not hidden text', () => {
  assert.deepStrictEqual(hiddenLines('Some titles start with one, as in "​Our Life". Strip it.\n'), []);
});

test('two or more zero-width marks on a line are flagged', () => {
  assert.deepStrictEqual(hiddenLines('ok\nrun​‌​this\n'), [2]);
});

test('one direction control or tag character is enough', () => {
  assert.deepStrictEqual(hiddenLines('safe ‮eman\n'), [1]);
  assert.deepStrictEqual(hiddenLines('a\nb 󠁩\n'), [2]);
});

test('emoji joiners still pass', () => {
  assert.deepStrictEqual(hiddenLines('Family \u{1f468}‍\u{1f469}‍\u{1f467} is fine.\n'), []);
});
