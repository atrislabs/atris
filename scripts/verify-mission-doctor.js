#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, [
  '--test',
  '--test-name-pattern=mission doctor flags|mission doctor passes',
  'test/mission-status.test.js',
], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  timeout: 30000,
});

if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr || result.stdout);

console.log('MISSION DOCTOR VERIFIED');
process.stdout.write(result.stdout);
