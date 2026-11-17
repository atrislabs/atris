'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');

test('shared checkout flags do not resume a matching mission in a separate checkout', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-shared-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(path.join(root, 'atris', 'team', 'demo'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'atris', 'team', 'demo', 'MEMBER.md'), '---\nname: demo\nrole: Builder\n---\n');
  const cwdFile = path.join(base, 'runner-cwd');
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
    'pwd > "$ATRIS_TEST_CWD_FILE"',
    'echo \'{"type":"result","is_error":false,"result":"finished"}\'',
    '',
  ].join('\n'), { mode: 0o755 });
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test User'], ['add', 'atris'], ['commit', '-qm', 'baseline']]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TEST_CWD_FILE: cwdFile,
    PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME']) delete env[name];
  for (const flag of ['--shared-checkout', '--no-worktree']) {
    const objective = `bounded work ${flag}`;
    const start = spawnSync(process.execPath, [cli, 'mission', 'start', objective,
      '--owner', 'demo', '--runner', 'claude', '--no-verify', '--worktree', '--json'],
    { cwd: root, encoding: 'utf8', env, timeout: 60000 });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const original = JSON.parse(start.stdout).mission;
    assert.notEqual(path.resolve(original.worktree.path), path.resolve(root));
    const explicit = spawnSync(process.execPath, [cli, 'member', 'run', 'demo', '--mission', original.id,
      '--runner', 'claude', flag, '--max-ticks', '1', '--no-verify', '--json'],
    { cwd: root, encoding: 'utf8', env, timeout: 60000 });
    assert.notEqual(explicit.status, 0);
    assert.match(JSON.parse(explicit.stdout).error, /separate checkout/);
    const result = spawnSync(process.execPath, [cli, 'member', 'run', 'demo', objective, '--runner', 'claude',
      flag, '--max-ticks', '1', '--no-verify', '--json'], { cwd: root, encoding: 'utf8', env, timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.realpathSync(fs.readFileSync(cwdFile, 'utf8').trim()), fs.realpathSync(root), flag);
  }
});
