'use strict';

// Caller regression. The refusal is synthetic; the CLI and task database
// are real. This checks reporting before the runner refusal is implemented.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const detail = 'could not run the check because the node folder contains a colon';

if (process.env.ATRIS_REFUSAL_CALLER_PROBE === 'launch') {
  // Use the production receipt writer with a real failed process launch.
  const writer = require('../../lib/task-receipt');
  const original = writer.writeTaskReceipt;
  writer.writeTaskReceipt = options => original({ ...options,
    runner: () => spawnSync(path.join(options.root, 'missing-check-runner'), [], { encoding: 'utf8' }),
  });
} else if (process.env.ATRIS_REFUSAL_CALLER_PROBE === '1') {
  require('../../lib/task-receipt').writeTaskReceipt = ({ command }) => ({
    ok: false, passed: false, reason: 'caller_runtime_path_unsupported',
    cmd: command, detail,
  });
} else {
  const { scrubAgentEnv } = require('../../test/helpers/agent-env');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-refusal-caller-'));
  const cli = path.resolve(__dirname, '../../bin/atris.js');
  const env = { ...scrubAgentEnv(), ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
    ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  const run = (args, refusal = false) => spawnSync(process.execPath,
    [...(refusal ? ['--require', __filename] : []), cli, ...args], {
      cwd: root, env: { ...env, ...(refusal ? { ATRIS_REFUSAL_CALLER_PROBE: refusal === 'launch' ? 'launch' : '1' } : {}) },
      encoding: 'utf8', timeout: 30000,
    });
  try {
    const init = run(['init', '--minimal', '--yes']);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const added = run(['task', 'add', 'Explain refused checks to the operator', '--json']);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    const ref = JSON.parse(added.stdout).task.display_id;
    const sentinel = path.join(root, 'command-ran.txt');
    const command = `printf ran > '${sentinel}'`;
    const cases = [
      ['ready', ['task', 'ready', ref, '--verify', command, '--result',
        'Operators can see why the check could not run, so they can choose a usable node folder.']],
      ['receipt text', ['task', 'receipt', ref, '--verify', command]],
      ['receipt json', ['task', 'receipt', ref, '--verify', command, '--json']],
    ];
    for (const [name, args] of cases) {
      const result = run(args, true);
      const output = (result.stdout + result.stderr).trim();
      assert.equal(result.status, 1, output);
      assert.ok(output.includes(detail), output);
      assert.ok(!output.includes('undefined'), output);
      assert.equal(fs.existsSync(sentinel), false);
      console.log(`${name}: exit ${result.status}; refusal detail retained`);
      console.log(output);
      if (name === 'receipt text') {
        assert.ok(!output.includes('(exit '), output);
        assert.ok(!output.includes('receipt written:'), output);
      }
      if (name === 'receipt json') {
        const json = JSON.parse(result.stdout);
        assert.equal(json.passed, false);
        assert.equal(json.reason, 'caller_runtime_path_unsupported');
        assert.equal(json.detail, detail);
        assert.equal(json.exit, undefined);
        assert.equal(json.receipt_path, undefined);
      }
    }
    const runs = path.join(root, 'atris', 'runs');
    assert.ok(!fs.existsSync(runs) || fs.readdirSync(runs).length === 0);
    for (const [name, args] of cases) {
      const result = run(args, 'launch');
      const output = (result.stdout + result.stderr).trim();
      assert.equal(result.status, 1, output);
      assert.ok(output.includes('ENOENT'), output);
      assert.ok(!output.includes('undefined'), output);
      assert.equal(fs.existsSync(sentinel), false);
      assert.ok(!fs.existsSync(runs) || fs.readdirSync(runs).length === 0);
      if (name === 'receipt json') {
        const json = JSON.parse(result.stdout);
        assert.equal(json.reason, 'verifier_spawn_failed');
        assert.ok(json.error.includes('ENOENT'));
        assert.equal(json.receipt_path, undefined);
      }
      console.log(`${name}: real launch failure; CLI exit ${result.status}; error retained; no receipt`);
      console.log(output);
    }
    // Real failures must keep their records when pre-launch refusal reporting
    // is repaired. No injected runner result is used for these controls.
    const failedCommand = `printf 'ordinary-failure-control\\n'; printf ran > '${sentinel}'; exit 7`;
    for (const [name, args] of cases) {
      const before = new Set(fs.existsSync(runs) ? fs.readdirSync(runs) : []);
      const failedArgs = args.map(arg => arg === command ? failedCommand : arg);
      const result = run(failedArgs);
      const output = (result.stdout + result.stderr).trim();
      assert.equal(result.status, 1, output);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'ran');
      const created = fs.readdirSync(runs).filter(file => !before.has(file));
      assert.equal(created.length, 1, output);
      const receiptPath = path.join('atris', 'runs', created[0]);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, receiptPath), 'utf8'));
      assert.equal(receipt.command, failedCommand);
      assert.equal(receipt.result.passed, false);
      assert.equal(receipt.result.exit, 7);
      assert.equal(receipt.result.output, 'ordinary-failure-control');
      assert.ok(output.includes(receiptPath), output);
      if (name === 'receipt json') {
        const json = JSON.parse(result.stdout);
        assert.equal(json.passed, false);
        assert.equal(json.exit, 7);
        assert.equal(json.receipt_path, receiptPath);
      } else {
        assert.ok(output.includes('exit 7'), output);
        assert.ok(output.includes('ordinary-failure-control'), output);
      }
      console.log(`${name}: real child exit 7; CLI exit ${result.status}; failed receipt retained`);
      console.log(output);
      fs.unlinkSync(sentinel);
    }
    const listed = run(['task', 'list', '--json']);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.ok(!listed.stdout.includes('"status": "review"'));
    console.log('three synthetic refusals and three real launch failures kept their explanation; three real failed checks retained receipts');
  } finally {
    // Only this invocation's generated fixture is removed.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
