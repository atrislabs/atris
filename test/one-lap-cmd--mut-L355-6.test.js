'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOneLap } = require('../commands/one-lap');

test('resuming a review task rejects a matching verifier receipt that is not review-only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-lap-review-proof-'));
  try {
    const state = path.join(root, '.atris', 'state');
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(runs, { recursive: true });
    const verifier = 'node --test';
    const task = { display_id: 'task-proof', title: 'fix parser', status: 'review' };
    const wish = {
      id: 'wish-proof', text: 'fix parser', status: 'delegated',
      task_id: task.display_id, mission_id: 'mission-proof',
    };
    fs.writeFileSync(path.join(state, 'wishes.jsonl'), JSON.stringify(wish) + '\n');
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: wish.mission_id, status: 'review', verifier,
    }) + '\n');
    const verifierResult = { passed: true, status: 0, command: verifier };
    fs.writeFileSync(path.join(runs, 'dispatch-proof.json'), JSON.stringify({
      schema: 'atris.dispatch_receipt.v1',
      // Matching commands must not bypass the earlier receipt requirements.
      review_only: false,
      context: { source: 'one_lap', wish_id: wish.id, mission_id: wish.mission_id },
      tasks: [task.display_id],
      ready: [{
        task: task.display_id, review_recorded: true, engine: 'builder',
        verifier_result: verifierResult,
      }],
      result: {
        passed: true, master_boundary_enforced: true, master_unchanged: true,
        verifier_result: verifierResult,
        validator_result: {
          passed: true, independent: true, worktree_unchanged: true,
          engine: 'reviewer', executor_engine: 'builder',
        },
      },
    }));
    const output = [];
    const code = await runOneLap(wish.text, {
      root, quiet: true, onResult: (result) => output.push(result),
      ownCli(args) {
        assert.deepEqual(args, ['task', 'show', task.display_id, '--json']);
        return { status: 0, stdout: JSON.stringify(task) };
      },
      progress() { assert.fail('resuming review must not start engine work'); },
    });
    assert.deepEqual(output, [{
      schema: 'atris.one_lap.v1', ok: false, status: 'stuck', ask: 'fix parser',
      wish_id: wish.id, task_id: task.display_id, mission_id: wish.mission_id,
      engine: null, validator: null, verifier,
      resumed: true,
      reason: 'the matching task is in Review without a passing matching one-lap receipt',
      next_action: 'atris task show task-proof',
    }]);
    assert.equal(code, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
