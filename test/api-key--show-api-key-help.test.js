'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { showApiKeyHelp } = require('../commands/api-key');

const expectedLines = [
  'usage: atris api-key create [name] [--cap usd]',
  '       atris api-key list',
  '       atris api-key rotate <id>',
  '       atris api-key revoke <id>',
  'create, list, rotate, or revoke a developer api key. add --json for machine output.',
];

test('showApiKeyHelp prints the complete help with no arguments', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args));

  assert.strictEqual(showApiKeyHelp(), undefined);
  assert.deepStrictEqual(lines, expectedLines.map((line) => [line]));
});

test('showApiKeyHelp prints complete help again on repeated calls', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));

  showApiKeyHelp();
  showApiKeyHelp();

  assert.deepStrictEqual(lines, [...expectedLines, ...expectedLines]);
});

test('showApiKeyHelp propagates an output error and stops printing', (t) => {
  const lines = [];
  const error = new Error('output unavailable');
  t.mock.method(console, 'log', (line) => {
    lines.push(line);
    throw error;
  });

  assert.throws(() => showApiKeyHelp(), (caught) => caught === error);
  assert.deepStrictEqual(lines, [expectedLines[0]]);
});
