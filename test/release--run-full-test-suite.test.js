'use strict';

// runFullTestSuite spawns `npm test` in a given directory. These tests point it
// at throwaway package.json fixtures inside fresh temp dirs so the real suite
// never runs, no machine state is read, and nothing reaches the network.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runFullTestSuite } = require('../commands/release');

for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-home-'));
process.env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
process.env.NO_UPDATE_NOTIFIER = '1';
process.env.npm_config_update_notifier = 'false';

const npmProbe = spawnSync('npm', ['--version'], { env: process.env, stdio: 'ignore' });
const needsNpm = { skip: !(!npmProbe.error && npmProbe.status === 0) && 'npm is not on PATH' };

function makeFixture(runJs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-suite-'));
  fs.writeFileSync(path.join(dir, 'run.js'), runJs);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'run-full-test-suite-fixture',
      private: true,
      version: '1.0.0',
      scripts: { test: 'node run.js' },
    })
  );
  return dir;
}

test('runFullTestSuite reports status 0 and injects CI=true for a passing suite', needsNpm, () => {
  const dir = makeFixture("require('fs').writeFileSync('ci.txt', String(process.env.CI));\n");

  const result = runFullTestSuite(dir);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'ci.txt'), 'utf8'), 'true');
});

test('runFullTestSuite surfaces the child exit code when the suite fails', needsNpm, () => {
  const dir = makeFixture('process.exit(3);\n');

  const result = runFullTestSuite(dir);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 3);
});

test('runFullTestSuite returns an error result for a missing directory', () => {
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-release-gone-'));
  const missing = path.join(gone, 'no-such-dir');

  const result = runFullTestSuite(missing);

  assert.ok(result.error instanceof Error);
  assert.equal(result.status, null);
});
