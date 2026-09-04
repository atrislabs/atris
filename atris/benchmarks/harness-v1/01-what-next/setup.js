'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function setup(ctx) {
  const atrisDir = path.join(ctx.workspace, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  const created = ctx.runCli([
    'task',
    'new',
    'review the tiny project and choose its next improvement',
    '--tag',
    'bench',
    '--json',
  ]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const payload = JSON.parse(created.stdout);
  fs.writeFileSync(path.join(ctx.workspace, '.bench-task-id'), `${payload.task_id}\n`, 'utf8');

  const renderedTodo = path.join(atrisDir, 'TODO.md');
  if (fs.existsSync(renderedTodo)) fs.unlinkSync(renderedTodo);
  if (fs.readdirSync(atrisDir).length === 0) fs.rmdirSync(atrisDir);
};
