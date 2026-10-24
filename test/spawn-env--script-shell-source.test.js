require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scriptShellSource } = require('../lib/spawn-env');

test('scriptShellSource emits a sh wrapper that puts the guard dir first', () => {
  const dir = '/tmp/atris-mission-git-abc123';
  const src = scriptShellSource(dir);
  const lines = src.split('\n');
  assert.equal(lines[0], '#!/bin/sh');
  assert.equal(lines[1], `G='${dir}'`);
  assert.ok(lines.includes('PATH="$G:$PATH"; export PATH'));
  assert.ok(lines.includes('shell="${ATRIS_SCRIPT_SHELL:-/bin/sh}"'));
  assert.ok(lines.includes('    sh|bash|zsh|dash|ksh|mksh|ash)'));
  assert.ok(src.endsWith('exec "$shell" "$@"\n'));
});

test('scriptShellSource single-quote-escapes a dir containing a quote', () => {
  const src = scriptShellSource("/tmp/o'hare/guards");
  assert.ok(src.includes(`G='/tmp/o'\\''hare/guards'`));
});

test('scriptShellSource handles an empty dir without throwing', () => {
  const src = scriptShellSource('');
  assert.ok(src.startsWith('#!/bin/sh\n'));
  assert.ok(src.includes(`G=''`));
  assert.ok(src.endsWith('exec "$shell" "$@"\n'));
});

test('scriptShellSource output parses as shell', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-script-shell-'));
  const file = path.join(tmp, 'script-shell.sh');
  fs.writeFileSync(file, scriptShellSource('/tmp/atris-mission-git-xyz'), 'utf8');
  const res = spawnSync('/bin/sh', ['-n', file], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});
