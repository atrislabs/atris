#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, ['bin/atris.js', 'chat', 'scan', '--json'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  timeout: 30000,
});

if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr || result.stdout);

const payload = JSON.parse(result.stdout);
assert.equal(payload.ok ?? true, true);
assert.equal(payload.action ?? 'chat_scan', 'chat_scan');
assert.ok(payload.summary && typeof payload.summary.sessions === 'number');

console.log('CHAT SCAN VERIFIED');
console.log(`sessions=${payload.summary.sessions}`);
console.log(`findings=${payload.summary.findings}`);
