'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Test Member',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

test('member status shows awake and asleep switch state', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'growth');

    const awake = runCli(['member', 'status', 'growth', '--json'], { cwd: root });
    assert.equal(awake.status, 0, awake.stderr || awake.stdout);
    const awakeBody = JSON.parse(awake.stdout);
    assert.equal(awakeBody.switch.awake, true);

    const sleep = runCli(['sleep', 'growth'], { cwd: root });
    assert.equal(sleep.status, 0, sleep.stderr || sleep.stdout);

    const text = runCli(['member', 'status', 'growth'], { cwd: root });
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.match(text.stdout, /switch\s+asleep/);

    const json = runCli(['member', 'status', 'growth', '--json'], { cwd: root });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const body = JSON.parse(json.stdout);
    assert.equal(body.switch.awake, false);

    runCli(['sleep', 'growth', '--loop', 'quality'], { cwd: root });
    const withLoop = runCli(['member', 'status', 'growth', '--json'], { cwd: root });
    assert.equal(withLoop.status, 0, withLoop.stderr || withLoop.stdout);
    const loopBody = JSON.parse(withLoop.stdout);
    assert.equal(loopBody.switch.loops.quality, false);
  } finally {
    cleanupTempDir(root);
  }
});
