const test = require('node:test');
const assert = require('node:assert/strict');

const { runMarker, newRunToken } = require('../lib/member-progress');

test('runMarker joins member and token into one marker line', () => {
  assert.equal(runMarker('growth', '0123456789abcdef'), 'atris-run growth 0123456789abcdef');
  assert.equal(runMarker('a', 'b'), 'atris-run a b');
});

test('runMarker wraps a fresh run token so stop can match the process', () => {
  const token = newRunToken();
  const marker = runMarker('growth', token);
  assert.match(marker, /^atris-run growth [0-9a-f]{16}$/);

  // member-board escapes the marker, then demands it right after the
  // shell's ': ' no-op or the engine's -p flag, as whole words.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shellShape = new RegExp(`^\\S+\\s+-lc\\s+:\\s+${escaped};`);
  const promptShape = new RegExp(`^\\S+\\s+-p\\s+${escaped}(?=\\s|\\\\012|\\?|$)`);
  // ps prints argv joined by spaces, so the shell's quote marks are gone.
  assert.ok(shellShape.test(`sh -lc : ${marker}; cd /repo && claude`), marker);
  assert.ok(promptShape.test(`claude -p ${marker}\nobjective`), marker);

  // Another member's marker must not match this member's process line.
  const other = runMarker('review', token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const otherShape = new RegExp(`^\\S+\\s+-lc\\s+:\\s+${other};`);
  assert.ok(!otherShape.test(`sh -lc : ${marker}; cd /repo && claude`));
});

test('runMarker passes its arguments through verbatim', () => {
  // No sanitizing here: safeMember() is the gate that strips bad member
  // names before they reach a filename, runMarker just formats.
  assert.equal(runMarker('growth member', 't o k'), 'atris-run growth member t o k');
  assert.equal(runMarker('a.b-c_d', 'x'), 'atris-run a.b-c_d x');
});

test('runMarker with missing arguments still returns the prefix', () => {
  assert.equal(runMarker(), 'atris-run undefined undefined');
  assert.equal(runMarker('growth'), 'atris-run growth undefined');
  assert.equal(runMarker('', ''), 'atris-run  ');
});
