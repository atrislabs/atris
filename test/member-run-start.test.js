'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-run-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'demo', 'MEMBER.md'), '---\nname: demo\nrole: Builder\n---\n');
  return root;
}

function fakeClaude(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then',
    '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
    '  exit 0',
    'fi',
    'echo \'{"type":"result","is_error":false,"result":"finished the bounded task"}\'',
    '',
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return bin;
}

function run(root, args, bin = null) {
  const result = spawnSync(process.execPath, [cli, 'member', 'run', 'demo', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(bin ? { PATH: `${bin}${path.delimiter}${process.env.PATH}` } : {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('member run without a check creates a mission but fails instead of claiming it ran', (t) => {
  const root = workspace(t);
  const result = run(root, ['bounded work', '--minutes', '1', '--json']);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, false);
  assert.equal(payload.state, 'planning');
  assert.ok(payload.mission_id);
  assert.equal(result.stderr.trim(), 'created, not started: add a check with --verify "<cmd>"');
});

test('member run with a check starts a headless run and reports its real state', (t) => {
  const root = workspace(t);
  const bin = fakeClaude(root);
  const result = run(root, ['bounded work', '--verify', 'node -e "process.exit(0)"', '--max-ticks', '1', '--minutes', '1', '--json'], bin);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.started, true);
  assert.equal(payload.mission.verifier, 'node -e "process.exit(0)"');
  assert.equal(payload.state, payload.mission.status);
  assert.ok(payload.ran_ticks > 0);
});

test('member run uses an explicit check in member config', (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'atris', 'team', 'demo', 'MEMBER.md'),
    '---\nname: demo\nrole: Builder\nverify: node -e "process.exit(0)"\n---\n');
  const bin = fakeClaude(root);
  const result = run(root, ['bounded work', '--max-ticks', '1', '--minutes', '1', '--json'], bin);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).started, true);
});
