'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packageScriptEnv } = require('../lib/spawn-env');

test('forwards a leading yarn working-directory flag and its value to config lookup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leading-config-flag-'));
  const realBin = path.join(dir, 'package-manager');
  const callFile = path.join(dir, 'args.json');
  fs.writeFileSync(realBin, `#!${process.execPath}
require('node:fs').writeFileSync(process.env.CALL_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write('/bin/sh\\n');
`, { mode: 0o700 });

  packageScriptEnv({ tool: 'yarn', realBin, scriptShell: path.join(dir, 'guard-shell') },
    { HOME: dir, CALL_FILE: callFile }, dir, ['--cwd', dir, 'run', 'build']);

  const args = JSON.parse(fs.readFileSync(callFile, 'utf8'));
  assert.strictEqual(args[0], '--cwd');
  assert.strictEqual(args[1], dir);
});
