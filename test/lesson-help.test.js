'use strict';

// `atris lesson --help` / `-h` is an explicit help request: it must print the
// usage block and exit 0 (a help flag is not an error), while a genuinely
// unknown subcommand still exits 1.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'bin', 'atris.js');
const repoRoot = path.join(__dirname, '..');

function run(args) {
  return spawnSync('node', [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
}

for (const flag of ['--help', '-h']) {
  test(`lesson ${flag} prints usage and exits 0`, () => {
    const r = run(['lesson', flag]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /Usage: atris lesson add/);
  });
}

test('lesson with an unknown subcommand still exits 1', () => {
  const r = run(['lesson', 'bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Usage: atris lesson add/);
});
