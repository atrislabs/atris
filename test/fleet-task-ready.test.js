'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fleet = require('../lib/fleet');
const taskDb = require('../lib/task-db');
const { scrubAgentEnv } = require('./helpers/agent-env');
const cliPath = path.resolve(__dirname, '../bin/atris.js');

for (const mode of ['fleet', 'dispatch']) {
  for (const rejectProof of [false, true]) {
    test(`${mode} preserves the real landing when task ready ${rejectProof ? 'rejects proof' : 'succeeds'}`, async () => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ready-handoff-')));
      const root = path.join(dir, 'repo');
      const worktree = path.join(dir, 'worker');
      fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
      const env = { ...scrubAgentEnv(), ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1', ATRIS_NONINTERACTIVE: '1' };
      function git(args, cwd = root) {
        const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      }
      function task(args) {
        const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
        assert.ifError(result.error);
        return result;
      }
      try {
        git(['init', '-b', 'main']);
        git(['config', 'user.name', 'handoff test']);
        git(['config', 'user.email', 'handoff@example.test']);
        git(['config', 'commit.gpgsign', 'false']);
        git(['config', 'core.hooksPath', '/dev/null']);
        fs.writeFileSync(path.join(root, '.gitignore'), 'atris/\n.atris/\n');
        fs.writeFileSync(path.join(root, 'result.txt'), 'before');
        fs.writeFileSync(path.join(root, 'check.test.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt', 'utf8'), 'after');\n");
        git(['add', '.']);
        git(['commit', '-m', 'before change']);
        const before = git(['rev-parse', 'HEAD']);
        git(['worktree', 'add', '-b', 'worker', worktree]);
        const db = taskDb.open(env.ATRIS_TASKS_DB);
        const created = taskDb.addTask(db, { title: 'Fix result.txt. Done: the saved result is correct. Check: node --test check.test.cjs.', tag: 'cli', workspaceRoot: root });
        taskDb.close();
        const shown = task(['task', 'show', created.id, '--json']);
        assert.equal(shown.status, 0, shown.stderr);
        const row = JSON.parse(shown.stdout);
        fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
        fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks: [row] }));
        const calls = [];
        let proofWasDurable = false;
        let readyResult;
        const ownCli = (args) => {
          calls.push(args);
          if (args[0] === 'worktree') return { status: 0, stdout: `next: cd ${worktree}\n`, stderr: '' };
          if (args[1] === 'ready') {
            const proof = args[args.indexOf('--proof') + 1];
            const receipt = proof.match(/Receipt saved at ([^ ]+[.]json)/)[1];
            const durable = JSON.parse(fs.readFileSync(path.join(root, receipt), 'utf8'));
            proofWasDurable = durable.landed.some(item => item.task === row.display_id && item.review_recorded === false);
            readyResult = task(args);
            return readyResult;
          }
          return task(args);
        };
        const logs = [];
        const options = {
          root, ownCli, log: line => logs.push(line),
          dispatcher: async () => {
            fs.writeFileSync(path.join(worktree, 'result.txt'), 'after');
            git(['add', 'result.txt'], worktree);
            git(['commit', '-m', 'correct saved result'], worktree);
            return { exitCode: 0, report: rejectProof ? 'node --test check.test.cjs passed' : 'saved result corrected' };
          },
          lander: () => {
            git(['merge', '--ff-only', 'worker']);
            git(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
            const verified = spawnSync(process.execPath, ['--test', 'check.test.cjs'], { cwd: root, env, encoding: 'utf8' });
            assert.equal(verified.status, 0, verified.stderr);
            const output = rejectProof ? `${verified.stdout}\nnode --test check.test.cjs passed` : verified.stdout;
            return { ok: true, stage: 'shipped', check: 'node --test check.test.cjs', verifyOutput: output, verifier_result: { passed: true, status: 0, output } };
          },
        };
        const flight = mode === 'fleet'
          ? await fleet.runFleetFlight({ ...options, engines: ['codex'], guardCliLink: () => ({ ok: true, changed: false }) })
          : await fleet.runDispatchFlight({ ...options, taskIds: [row.display_id], engine: 'codex' });
        assert.notEqual(git(['rev-parse', 'HEAD']), before);
        assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8'), 'after');
        assert.equal(proofWasDurable, true, 'the landed change must be saved before task ready runs');
        assert.ok(readyResult, 'the real task command must run');
        const current = JSON.parse(task(['task', 'show', created.id, '--json']).stdout);
        assert.equal(current.status, rejectProof ? 'claimed' : 'review', readyResult.stderr);
        assert.notEqual(current.review?.approval_status, 'accepted');
        assert.equal(flight.landed.length, 1);
        assert.equal(flight.landed[0].review_recorded, !rejectProof);
        assert.equal(flight.status, rejectProof ? 'failed' : 'completed');
        assert.equal(calls.some(args => args[1] === 'release' || args[1] === 'accept'), false);
        if (rejectProof) {
          assert.notEqual(readyResult.status, 0);
          assert.match(readyResult.stderr, /this process did not run it/);
          assert.equal(flight.paused[0].stage, 'task_ready');
          assert.equal(flight.paused[0].landed, true);
          assert.match(flight.paused[0].next_action, /do not rebuild/);
          assert.ok(logs.some(line => /saving its proof failed/.test(line)));
        }
        const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
        assert.equal(receipt.landed[0].review_recorded, !rejectProof);
        assert.equal(receipt.status, flight.status);
      } finally {
        taskDb.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
