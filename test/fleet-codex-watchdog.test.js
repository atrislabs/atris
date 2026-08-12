'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fleet = require('../lib/fleet');

const WATCHDOG = path.join(__dirname, '..', 'scripts', 'det', 'codex-watchdog.js');

test('buildEngineCommand wraps codex through the watchdog with stdin sealed', () => {
  const cmd = fleet.buildEngineCommand('codex', '/tmp/p.md');
  assert.match(cmd, new RegExp(`^node ${WATCHDOG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --startup-deadline 90 --max-runtime 3600 -- sh -c '`));
  assert.match(cmd, /<\/dev\/null$/);
  assert.match(cmd, /sh -c 'codex exec /);
});

test('buildEngineCommand keeps sealed and yolo flags inside the wrapped codex command', () => {
  const sealed = fleet.buildEngineCommand('codex', '/tmp/p.md', { sealed: true });
  assert.match(sealed, /codex-watchdog\.js/);
  assert.match(sealed, /<\/dev\/null$/);
  assert.match(sealed, /sh -c 'codex exec --sandbox workspace-write --ephemeral --ignore-user-config --ignore-rules /);

  const yolo = fleet.buildEngineCommand('codex', '/tmp/p.md', { yolo: true });
  assert.match(yolo, /codex-watchdog\.js/);
  assert.match(yolo, /<\/dev\/null$/);
  assert.match(yolo, /sh -c 'codex exec --dangerously-bypass-approvals-and-sandbox /);
});

test('buildEngineCommand leaves non-codex engines unwrapped', () => {
  assert.match(fleet.buildEngineCommand('cursor', '/tmp/p.md'), /^cursor-agent --trust -p/);
  assert.doesNotMatch(fleet.buildEngineCommand('cursor', '/tmp/p.md'), /codex-watchdog/);
  assert.match(fleet.buildEngineCommand('claude', '/tmp/p.md'), /^claude -p /);
  assert.doesNotMatch(fleet.buildEngineCommand('claude', '/tmp/p.md'), /codex-watchdog/);
  assert.match(fleet.buildEngineCommand('devin', '/tmp/p.md'), /^devin -p --permission-mode dangerous /);
  assert.doesNotMatch(fleet.buildEngineCommand('devin', '/tmp/p.md'), /codex-watchdog/);
});
