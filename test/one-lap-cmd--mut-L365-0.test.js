'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOneLap } = require('../commands/one-lap');

test('dispatch receipt requires validator executor engine to match ready engine', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-test-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const stateDir = path.join(root, '.atris', 'state');
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });

    const taskId = 'task-101';
    const wishId = 'wish-101';
    const missionId = 'mission-101';
    const verifier = 'node --test';

    const wishRecord = {
      id: wishId,
      text: 'fix parser bug',
      status: 'running',
      mission_id: missionId,
      task_id: taskId,
    };
    fs.writeFileSync(path.join(stateDir, 'wishes.jsonl'), `${JSON.stringify(wishRecord)}\n`);

    const missionRecord = {
      id: missionId,
      status: 'running',
      verifier,
    };
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify(missionRecord)}\n`);

    const verifierResult = {
      command: verifier,
      passed: true,
      status: 0,
    };

    const receipt = {
      schema: 'atris.dispatch_receipt.v1',
      review_only: true,
      context: {
        source: 'one_lap',
        wish_id: wishId,
        mission_id: missionId,
      },
      tasks: [taskId],
      ready: [
        {
          task: taskId,
          engine: 'codex',
          review_recorded: true,
          verifier_result: verifierResult,
        },
      ],
      result: {
        passed: true,
        master_boundary_enforced: true,
        master_unchanged: true,
        verifier_result: verifierResult,
        validator_result: {
          passed: true,
          independent: true,
          worktree_unchanged: true,
          engine: 'claude',
          executor_engine: 'codex',
        },
      },
    };
    fs.writeFileSync(path.join(runsDir, 'dispatch-receipt-101.json'), JSON.stringify(receipt));

    let reportedResult = null;
    const code = await runOneLap('fix parser bug', {
      root,
      quiet: true,
      onResult(result) {
        reportedResult = result;
      },
      ownCli(args) {
        if (args[0] === 'task' && args[1] === 'show' && args[2] === taskId) {
          return {
            status: 0,
            stdout: JSON.stringify({
              id: taskId,
              display_id: taskId,
              title: 'fix parser bug',
              status: 'review',
            }),
          };
        }
        return { status: 1, stdout: '' };
      },
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(reportedResult && reportedResult.status, 'done');
    assert.strictEqual(reportedResult && reportedResult.reason, 'the matching lap is already proof ready');
  } finally {
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
