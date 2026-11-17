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
    fs.writeFileSync(path.join(ctx.workspace, 'bench-boot-review-proof.js'), 'module.exports = { ok: true };\n');
    parseJson(ctx.runCli([
      'task', 'ready', taskRef(review),
      '--verify', 'node --check bench-boot-review-proof.js',
      '--result', 'Operators can now trust the boot panel review count instead of guessing what is waiting.',
      '--as', 'bench',
      '--json',
    ]));
    parseJson(ctx.runCli(['task', 'review', taskRef(review), '--reward', '0', '--as', 'bench-review', '--json']));

    const boot = ctx.runCli(['atris.md']);
    assert.equal(boot.status, 0, boot.stderr || boot.stdout);
    // Sentences wrap at the window edge; read them as one line.
    const out = boot.stdout.replace(/\s+/g, ' ');

    // The boot panel speaks in whole sentences (not "Tasks: N open").
    // It must still reflect the real lane counts from task state: 2 backlog,
    // 1 active, 1 in review, and that one already certified and waiting for
    // a human ok (so nothing is left waiting for the agent check).
    const numberAfter = (phrase) => {
      const match = out.match(new RegExp(`${phrase} (\\d+)`));
      return match ? Number(match[1]) : null;
    };
    assert.equal(numberAfter('Waiting on you:'), 1, `certified review count in boot:\n${out}`);
    assert.equal(numberAfter('Not started:'), 2, `backlog count in boot:\n${out}`);
    assert.ok(!/Waiting for a check:/.test(out), `certified work counted twice in boot:\n${out}`);

    // The single active task is surfaced by name (not rolled into "N more").
    assert.ok(/Working now: an agent is on "/.test(out), `active lane row missing from boot:\n${out}`);
    assert.ok(out.includes('claim the active count'), `active task title missing from boot:\n${out}`);
  },
};
