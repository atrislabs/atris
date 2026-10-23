'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { showCiHelp } = require('../commands/ci');

const expectedLines = [
  'atris ci runs github actions jobs on this machine with a warm local work folder.',
  'change runs-on: ubuntu-latest to runs-on: atris.',
  'a GITHUB_TOKEN or an authenticated gh cli is required.',
  'usage: atris ci runner --repo <owner/name> [--repo <owner/name> ...] [--label <name>] [--once]',
  '       atris ci usage [--repo <owner/name>]',
];

test('showCiHelp prints complete help without any arguments', (t) => {
  const calls = [];
  t.mock.method(console, 'log', (...args) => calls.push(args));

  assert.strictEqual(showCiHelp(), undefined);
  assert.deepStrictEqual(calls, expectedLines.map((line) => [line]));
});

test('showCiHelp prints complete help again on repeated calls', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));

  showCiHelp();
  showCiHelp();

  assert.deepStrictEqual(lines, [...expectedLines, ...expectedLines]);
});

test('showCiHelp propagates an output error and stops printing', (t) => {
  const calls = [];
  const outputError = new Error('output is unavailable');
  t.mock.method(console, 'log', (...args) => {
    calls.push(args);
    throw outputError;
  });

  assert.throws(() => showCiHelp(), (error) => error === outputError);
  assert.deepStrictEqual(calls, [[expectedLines[0]]]);
});
