'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function taskRef(payload) {
  return payload.task.display_id || payload.task.ref || payload.task_id;
}

module.exports = {
  id: 'task-proof-gate',
  title: 'Task ready gate rejects weak or failing proof and accepts executed proof',
  timeoutMs: 30000,
  async run(ctx) {
    fs.mkdirSync(path.join(ctx.workspace, 'atris'), { recursive: true });
    const created = parseJson(ctx.runCli(['task', 'new', 'Weak proof wastes reviews: require executed evidence', '--tag', 'bench', '--json']));
    const ref = taskRef(created);
    parseJson(ctx.runCli(['task', 'claim', ref, '--as', 'bench', '--json']));

    const weak = ctx.runCli(['task', 'ready', ref, '--proof', 'done', '--json']);
    assert.notEqual(weak.status, 0);
    assert.equal(parseJson(ctx.runCli(['task', 'show', ref, '--json'])).status, 'claimed');

    const result = 'Reviewers can now trust that proof was executed instead of taking claims on faith.';
    const failingVerifier = `${process.execPath} -e "process.exit(4)"`;
    const failed = ctx.runCli(['task', 'ready', ref, '--verify', failingVerifier, '--result', result, '--json']);
    assert.equal(failed.status, 1);
    assert.equal(parseJson(ctx.runCli(['task', 'show', ref, '--json'])).status, 'claimed');

    const passingVerifier = `${process.execPath} -e "process.exit(0)"`;
    const ready = parseJson(ctx.runCli(['task', 'ready', ref, '--verify', passingVerifier, '--result', result, '--as', 'bench', '--json']));
    assert.equal(ready.task.status, 'review');
    assert.equal(ready.approval_status, 'pending');

    const runsDir = path.join(ctx.workspace, 'atris', 'runs');
    const receipts = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((file) => file.endsWith('.json')) : [];
    assert.ok(receipts.length >= 1, 'task ready --verify should write a receipt');
  },
};
