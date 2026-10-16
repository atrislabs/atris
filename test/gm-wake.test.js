'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('./helpers/member-cli');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-wake-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Test Navigator',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

test('gm <member> dispatches wake when the member switch is awake', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'maze');
    const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), NODE_NO_WARNINGS: '1' };

    const res = runCli(['gm', 'maze'], { cwd: root, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /maze is waking up/i);
    assert.doesNotMatch(res.stdout, /AgentXP General Manager/);
  } finally {
    cleanupTempDir(root);
  }
});

test('gm <member> exits 0 without dispatch when the member is asleep', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'maze');
    const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), NODE_NO_WARNINGS: '1' };

    assert.equal(runCli(['sleep', 'maze'], { cwd: root, env }).status, 0);

    const res = runCli(['gm', 'maze'], { cwd: root, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim().toLowerCase(), 'maze is asleep');
    assert.doesNotMatch(res.stdout, /waking up/i);
  } finally {
    cleanupTempDir(root);
  }
});

test('atris wake <member> re-enables gm dispatch', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'maze');
    const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), NODE_NO_WARNINGS: '1' };

    assert.equal(runCli(['sleep', 'maze'], { cwd: root, env }).status, 0);
    assert.equal(runCli(['wake', 'maze'], { cwd: root, env }).status, 0);

    const res = runCli(['gm', 'maze'], { cwd: root, env });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /maze is waking up/i);
  } finally {
    cleanupTempDir(root);
  }
});
