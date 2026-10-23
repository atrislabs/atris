'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ciCommand } = require('../commands/ci');

test('ci with no arguments prints the complete help', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args));

  let failure;
  const result = await ciCommand([]).catch((error) => {
    failure = error;
  });

  assert.deepEqual(output, [
    ['atris ci runs github actions jobs on this machine with a warm local work folder.'],
    ['change runs-on: ubuntu-latest to runs-on: atris.'],
    ['a GITHUB_TOKEN or an authenticated gh cli is required.'],
    ['usage: atris ci runner --repo <owner/name> [--repo <owner/name> ...] [--label <name>] [--once]'],
    ['       atris ci usage [--repo <owner/name>]'],
  ]);
  assert.equal(failure, undefined);
  assert.equal(result, 0);
});
