'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

const RETIRED = ['brainstormer', 'executor', 'launcher', 'navigator', 'researcher'];

const CUSTOM_VALIDATOR = [
  '---',
  'name: validator',
  'role: Review Desk',
  'description: Reviews every landing against the proof it claims.',
  'version: 1.0.0',
  'agent: claude',
  'model: claude-sonnet-5-5',
  '---',
  '',
  '# Validator, Review Desk',
  '',
].join('\n');

const STRONG_HOOK = [
  '#!/bin/bash',
  '# project hook: nonce check, queue, proof before pop',
  'NONCE_FILE=.atris/state/stop-nonce',
  '',
].join('\n');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-update-team-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const atrisDir = path.join(workspace, 'atris');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(atrisDir, 'team', 'validator'), { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'atris.md'), 'project atris spec\n', 'utf8');
  for (const name of RETIRED) {
    const archived = path.join(atrisDir, 'team', '_archived', `${name}-2026-10-01`);
    fs.mkdirSync(archived, { recursive: true });
    fs.writeFileSync(path.join(archived, 'MEMBER.md'), `# ${name}, retired\n`, 'utf8');
  }
  fs.writeFileSync(path.join(atrisDir, 'team', 'validator', 'MEMBER.md'), CUSTOM_VALIDATOR, 'utf8');
  const hookDir = path.join(atrisDir, 'skills', 'autopilot', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'stop-hook.sh'), STRONG_HOOK, 'utf8');
  return { root, workspace, home, atrisDir };
}

function runUpdateYes(fixture) {
  return spawnSync(process.execPath, [cliPath, 'update', '--yes'], {
    cwd: fixture.workspace,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...scrubAgentEnv(),
      HOME: fixture.home,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
}

test('update --yes does not recreate members retired to team/_archived', () => {
  const fixture = makeProject();
  try {
    const result = runUpdateYes(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const name of RETIRED) {
      assert.equal(
        fs.existsSync(path.join(fixture.atrisDir, 'team', name)),
        false,
        `update recreated retired member ${name}`,
      );
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('update --yes keeps a customized MEMBER.md and says a newer template exists', () => {
  const fixture = makeProject();
  try {
    const result = runUpdateYes(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const after = fs.readFileSync(path.join(fixture.atrisDir, 'team', 'validator', 'MEMBER.md'), 'utf8');
    assert.equal(after, CUSTOM_VALIDATOR);
    assert.match(result.stdout, /Kept team\/validator\/MEMBER\.md \(newer template exists/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('update --yes never replaces a project hook that differs from the shipped one', () => {
  const fixture = makeProject();
  const hookPath = path.join(fixture.atrisDir, 'skills', 'autopilot', 'hooks', 'stop-hook.sh');
  const globalHook = path.join(fixture.home, '.claude', 'skills', 'autopilot', 'hooks', 'stop-hook.sh');
  fs.mkdirSync(path.dirname(globalHook), { recursive: true });
  fs.writeFileSync(globalHook, STRONG_HOOK, 'utf8');
  try {
    const result = runUpdateYes(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(hookPath, 'utf8'), STRONG_HOOK, 'project hook was downgraded');
    assert.equal(fs.readFileSync(globalHook, 'utf8'), STRONG_HOOK, 'global hook was downgraded');
    // Non-hook skill files still sync.
    assert.ok(fs.existsSync(path.join(fixture.atrisDir, 'skills', 'autopilot', 'SKILL.md')));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
