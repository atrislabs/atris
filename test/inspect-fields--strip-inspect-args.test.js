'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stripInspectArgs } = require('../lib/inspect-fields');

test('removes inspect flags and field lists while preserving remaining arguments', () => {
  const args = ['--json', 'task-ref', '--fields', 'status,title', '--verbose', 'extra'];
  const original = args.slice();

  assert.deepStrictEqual(stripInspectArgs(args), ['task-ref', '--verbose', 'extra']);
  assert.deepStrictEqual(args, original);
});

test('removes repeated inspect flags wherever they appear', () => {
  assert.deepStrictEqual(
    stripInspectArgs(['--fields', 'status', 'ref', '--json', '--fields', 'title', '--json']),
    ['ref']
  );
});

test('supports a custom field flag and preserves the default flag', () => {
  assert.deepStrictEqual(
    stripInspectArgs(['--select', 'status', '--fields', 'title', 'ref', '--json'], {
      flagName: '--select',
    }),
    ['--fields', 'title', 'ref']
  );
});

test('returns an empty array for empty input or only inspect arguments', () => {
  assert.deepStrictEqual(stripInspectArgs([]), []);
  assert.deepStrictEqual(stripInspectArgs(['--json', '--fields', 'status']), []);
  assert.deepStrictEqual(stripInspectArgs(['--fields']), []);
});

test('preserves unrelated values and matches flag names exactly', () => {
  assert.deepStrictEqual(
    stripInspectArgs(['--json=true', '--fields=status', '--JSON', 0, null, false]),
    ['--json=true', '--fields=status', '--JSON', 0, null, false]
  );
});
