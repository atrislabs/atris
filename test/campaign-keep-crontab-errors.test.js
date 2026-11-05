'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installKeep, removeKeep, planKeep } = require('../lib/campaign-keep');
const { ideaAtris } = require('../commands/idea');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-crontab-read-'));
  const plan = planKeep({ root, home: path.join(root, 'state'), platform: 'linux', atrisBin: '/synthetic/atris' });
  return { root, plan };
}

for (const scenario of [
  { name: 'permission failure', result: { status: 1, stderr: 'permission denied' } },
  { name: 'missing executable', result: { status: null, error: new Error('spawn ENOENT') } },
  { name: 'killed command', result: { status: null, signal: 'SIGTERM', stderr: '' } },
  { name: 'mixed error diagnostic', result: { status: 1, stderr: 'no crontab for synthetic-user\npermission denied\n' } },
]) {
  test(`timer installation refuses a crontab ${scenario.name} without writing`, () => {
    const { root, plan } = fixture();
    try {
      const calls = [];
      const result = installKeep(plan, { spawn(_command, args) { calls.push(args[0]); return scenario.result; } });
      assert.equal(result.ok, false);
      assert.deepEqual(calls, ['-l']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test(`timer removal reports a crontab ${scenario.name}`, () => {
    const { root, plan } = fixture();
    try {
      const calls = [];
      const result = removeKeep(plan, { spawn(_command, args) { calls.push(args[0]); return scenario.result; } });
      assert.equal(result.ok, false);
      assert.deepEqual(calls, ['-l']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('a known absent crontab can still install a first timer', () => {
  const { root, plan } = fixture();
  try {
    const calls = [];
    const result = installKeep(plan, { spawn(_command, args, options) {
      calls.push(args[0]);
      if (args[0] === '-l') return { status: 1, stderr: 'no crontab for synthetic-user\n' };
      assert.match(options.input, new RegExp(plan.marker));
      return { status: 0 };
    } });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['-l', '-']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a known absent crontab needs no removal', () => {
  const { root, plan } = fixture();
  try {
    const calls = [];
    const result = removeKeep(plan, { spawn(_command, args) {
      calls.push(args[0]);
      return { status: 1, stderr: 'no crontab for synthetic-user\n' };
    } });
    assert.deepEqual(result, { ok: true, removed: false });
    assert.deepEqual(calls, ['-l']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('idea timer reports read failure without changing the crontab', () => {
  const { root } = fixture();
  try {
    const calls = [];
    const lines = [];
    const code = ideaAtris(['on'], {
      cwd: root,
      log: (line) => lines.push(String(line)),
      keepDeps: {
        plan: { home: path.join(root, 'state'), homeDir: root, platform: 'linux' },
        spawn(_command, args) { calls.push(args[0]); return { status: 1, stderr: 'permission denied' }; },
      },
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /could not read crontab/);
    assert.deepEqual(calls, ['-l']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
