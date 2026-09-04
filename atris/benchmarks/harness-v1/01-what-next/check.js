'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'what-next',
  title: 'choose the next project task',
  category: 'concierge',
  async check(ctx) {
    const transcript = `${ctx.engineResult.stdout}\n${ctx.engineResult.stderr}`;
    const invokedAtris = /\batris (next|task|status|now|ready|atris\.md)\b/.test(transcript);

    const taskId = fs.readFileSync(path.join(ctx.workspace, '.bench-task-id'), 'utf8').trim();
    const listed = ctx.runCli(['task', 'list', '--json']);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const task = JSON.parse(listed.stdout).tasks.find((entry) => entry.id === taskId);
    const stateChanged = Boolean(task && (task.status === 'claimed' || task.status === 'done'));

    assert.equal(invokedAtris || stateChanged, true, 'no atris command or seeded task state change found');
  },
};
