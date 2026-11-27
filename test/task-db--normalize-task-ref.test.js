'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeTaskRef, withTaskDisplayRefs } = require('../lib/task-db');

test('normalizeTaskRef normalizes task references and preserves letters and digits', () => {
  assert.strictEqual(normalizeTaskRef('cli-42'), 'CLI42');
  assert.strictEqual(normalizeTaskRef('01abcDEF234'), '01ABCDEF234');
  assert.strictEqual(normalizeTaskRef('CLI42'), 'CLI42');
});

test('normalizeTaskRef removes whitespace, punctuation, and non-ASCII characters', () => {
  assert.strictEqual(normalizeTaskRef(' \t[cli_0042]./\n'), 'CLI0042');
  assert.strictEqual(normalizeTaskRef('éß中🙂a-z９9'), 'AZ9');
  assert.strictEqual(normalizeTaskRef('000-007'), '000007');
});

test('normalizeTaskRef returns an empty string for missing, falsy, or stripped input', () => {
  for (const value of [undefined, null, '', false, 0, NaN, ' \t\n', '-_!🙂']) {
    assert.strictEqual(normalizeTaskRef(value), '');
  }
  assert.strictEqual(normalizeTaskRef(), '');
});

test('normalizeTaskRef coerces truthy non-string values before normalization', () => {
  assert.strictEqual(normalizeTaskRef(12345), '12345');
  assert.strictEqual(normalizeTaskRef(true), 'TRUE');
  assert.strictEqual(normalizeTaskRef({ toString: () => 'cli-42' }), 'CLI42');
});

test('task links keep their shortest prefixes against the full history of their own workspace', () => {
  const row = (id, created_at, workspace_root = '/example/one') => ({ id, created_at, workspace_root });
  const hidden = row('abcd0000-a9', 1);
  const left = row('ABCD0000A1', 2);
  const prefix = row('abcd0000-B', 3);
  const right = row('ABCD0000B1', 4);
  const duplicate = row('zyxw0000-a', 5);
  const otherDuplicate = row('ZYXW0000A', 6);
  const kept = { ...row('saved-ref-id', 7), legacy_ref: 'kept-ref', display_id: 'kept-id' };
  const short = row('xy', 8);
  const otherWorkspace = row('abcd0000a2', 8, '/example/two');
  const visible = [right, left, prefix, duplicate, otherDuplicate, short, kept, otherWorkspace];
  const rows = withTaskDisplayRefs(visible, [hidden, prefix, otherWorkspace, otherDuplicate, left, right]);
  assert.deepStrictEqual(rows.map(r => [r.id, r.display_id, r.legacy_ref]), [
    [right.id, 'ONE-4', 'ABCD0000B1'],
    [left.id, 'ONE-2', 'ABCD0000A1'],
    [prefix.id, 'ONE-3', 'ABCD0000B'],
    [duplicate.id, 'ONE-5', 'ZYXW0000A'],
    [otherDuplicate.id, 'ONE-6', 'ZYXW0000A'],
    [short.id, 'ONE-8', 'XY'],
    [kept.id, 'kept-id', 'kept-ref'],
    [otherWorkspace.id, 'TWO-1', 'ABCD0000'],
  ]);
});
