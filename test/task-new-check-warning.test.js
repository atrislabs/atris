'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCli } = require('./helpers/task-admin-cli');

test('task new warns about a missing check without breaking json', () => {
  const root = fs.mkdtempSync(path.join(__dirname, '.task-new-warning-'));
  const env = { ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_AGENT_PROOF_ONLY: '0' };
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    const missing = runCli(['task', 'new', 'missing check', '--why', 'needed', '--done-looks-like', 'done'], { cwd: root, env });
    assert.equal(missing.status, 0, missing.stderr);
    const ref = missing.stdout.split(/\s+/)[0];
    assert.match(missing.stdout, new RegExp(`no check yet.*cannot be marked ready.*atris task ready ${ref} --verify "<command>" --result "<result>"`));

    const checked = runCli(['task', 'new', 'has check', '--verify', 'node --test test/example.test.js'], { cwd: root, env });
    assert.equal(checked.status, 0, checked.stderr);
    assert.doesNotMatch(checked.stdout, /no check yet/);

    const json = runCli(['task', 'new', 'json check', '--json'], { cwd: root, env });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).action, 'created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
