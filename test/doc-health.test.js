'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cli = path.resolve(__dirname, '../bin/atris.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-doc-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [cli, 'doc-health', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

test('missing atris folder exits 1 with a plain message and JSON error', t => {
  const root = workspace(t);
  const text = run(root);
  assert.equal(text.status, 1, text.stderr);
  assert.equal(text.stdout.trim(), 'no atris/ folder in this workspace.');
  const json = run(root, ['--json']);
  assert.equal(json.status, 1, json.stderr);
  assert.equal(JSON.parse(json.stdout).ok, false);
});

test('boot load reports all files, missing files, and oversized files', t => {
  const root = workspace(t);
  write(root, 'atris/atris.md', '');
  write(root, 'AGENTS.md', 'x'.repeat(20001));
  const result = run(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const { boot_load } = JSON.parse(result.stdout);
  assert.equal(boot_load.files.length, 11);
  assert.equal(boot_load.total_chars, 20001);
  assert.equal(boot_load.approximate_tokens, 5000.25);
  assert.equal(boot_load.files.find(file => file.path === 'AGENTS.md').oversized, true);
  assert.equal(boot_load.files.find(file => file.path === 'CLAUDE.md').missing, true);
});
