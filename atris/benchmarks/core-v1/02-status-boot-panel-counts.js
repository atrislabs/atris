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
  id: 'status-boot-panel-counts',
  title: 'Boot panel reads backlog, active, and review lane counts from task state',
  timeoutMs: 30000,
  async run(ctx) {
    fs.mkdirSync(path.join(ctx.workspace, 'atris'), { recursive: true });
    parseJson(ctx.runCli(['task', 'new', 'Slow demos cost trust: keep one backlog count honest', '--tag', 'bench', '--json']));
    parseJson(ctx.runCli(['task', 'new', 'Operators lose state when queues drift: keep another backlog count honest', '--tag', 'bench', '--json']));
    const active = parseJson(ctx.runCli(['task', 'new', 'Review queues stall handoffs: claim the active count', '--tag', 'bench', '--json']));
    parseJson(ctx.runCli(['task', 'claim', taskRef(active), '--as', 'bench', '--json']));

    const review = parseJson(ctx.runCli(['task', 'new', 'Finished proof waits on people: surface the review count', '--tag', 'bench', '--json']));
    parseJson(ctx.runCli(['task', 'claim', taskRef(review), '--as', 'bench', '--json']));
    parseJson(ctx.runCli([
      'task', 'ready', taskRef(review),
      '--proof', 'node --test test/bench-tasks.test.js passed',
      '--as', 'bench',
      '--json',
    ]));
    parseJson(ctx.runCli(['task', 'review', taskRef(review), '--reward', '0', '--as', 'bench-review', '--json']));

    const boot = ctx.runCli(['atris.md']);
    assert.equal(boot.status, 0, boot.stderr || boot.stdout);
    const taskLine = boot.stdout.split(/\r?\n/).find((line) => line.includes('Tasks:')) || '';
    const reviewLine = boot.stdout.split(/\r?\n/).find((line) => line.includes('Review:')) || '';
    const taskNumbers = (taskLine.match(/\d+/g) || []).map(Number);
    const reviewNumbers = (reviewLine.match(/\d+/g) || []).map(Number);
    assert.deepEqual(taskNumbers.slice(0, 2), [2, 1]);
    assert.deepEqual(reviewNumbers.slice(0, 2), [1, 1]);
  },
};
