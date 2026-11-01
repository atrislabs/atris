'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runMergeGate } = require('../lib/merge-gate');

test('a non-executable gate still runs through its declared interpreter', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gate-interpreter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'gate.sh');
  fs.writeFileSync(script, '#!/usr/bin/env bash\nshopt -qo posix && exit 8\nexit 0\n');
  const result = runMergeGate(root, script);
  assert.equal(result.code, 0, result.output || result.error);
});

test('a gate stopped by a signal reports the conventional exit code', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gate-signal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'gate.sh');
  fs.writeFileSync(script, '#!/bin/sh\nkill -TERM $$\n');
  const result = runMergeGate(root, script);
  assert.equal(result.code, 143);
});
