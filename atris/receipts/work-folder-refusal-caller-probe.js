'use strict';

// Advisory caller probe. The refusal is synthetic; the CLI and task database
// are real. This isolates reporting before the runner refusal is implemented.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const detail = 'could not run the check because the node folder contains a colon';

if (process.env.ATRIS_REFUSAL_CALLER_PROBE === '1') {
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
      cwd: root, env: { ...env, ...(refusal ? { ATRIS_REFUSAL_CALLER_PROBE: '1' } : {}) },
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
      assert.ok(!output.includes(detail), 'baseline changed: caller now reports refusal');
      assert.equal(fs.existsSync(sentinel), false);
      console.log(`${name}: exit ${result.status}; refusal detail absent`);
      console.log(output);
      if (name === 'receipt text') {
        assert.ok(output.includes('exit undefined'));
        assert.ok(output.includes('receipt written: undefined'));
      }
      if (name === 'receipt json') {
        const json = JSON.parse(result.stdout);
        assert.equal(json.passed, false);
        assert.equal(json.reason, undefined);
        assert.equal(json.detail, undefined);
      }
    }
    const runs = path.join(root, 'atris', 'runs');
    assert.ok(!fs.existsSync(runs) || fs.readdirSync(runs).length === 0);
    const listed = run(['task', 'list', '--json']);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.ok(!listed.stdout.includes('"status": "review"'));
    console.log('three real CLI calls, synthetic refusal; no check ran or receipt was written');
  } finally {
    // Only this invocation's generated fixture is removed.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
