'use strict';

// Real colon-directory Node exercises both production runners and task CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildVerifiedProof } = require('../../lib/task-proof');
const { writeTaskReceipt } = require('../../lib/task-receipt');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

if (process.argv[2] === '--child') {
  const root = process.argv[3];
  assert.ok(path.dirname(process.execPath).includes(':'));
  const competitor = path.join(root, 'competing');
  let calls = 0;
  const runner = (file, args, options) => {
    assert.equal(file, 'bash');
    assert.equal(args[0], '-lc');
    calls++;
    return spawnSync(file, ['-lc', `export PATH=${quote(competitor)}:"$PATH"\n${args[1]}`], options);
  };
  for (const kind of ['shared', 'receipt']) {
    const sentinel = path.join(root, `${kind}-ran.txt`);
    const command = `printf ran > ${quote(sentinel)}; node --version`;
    const result = kind === 'shared'
      ? buildVerifiedProof(command, '', runner, { cwd: root })
      : writeTaskReceipt({ taskId: 'paired-runtime-probe', command, root, runner });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, 'caller_runtime_path_unsupported');
    assert.equal(result.detail, 'could not run the check because the node folder contains a colon');
    assert.equal(result.exit, undefined);
    assert.equal(result.cmd, command);
    assert.equal(fs.existsSync(sentinel), false);
    if (kind === 'receipt') {
      assert.equal(result.passed, false);
      assert.equal(result.receiptFile, undefined);
    } else {
      assert.equal(result.proof, undefined);
    }
    console.log(`${kind}: refused before launch; explanation retained; no command side effect or receipt`);
  }
  // Existing validation still wins without launching any process.
  assert.equal(buildVerifiedProof('', '', runner).reason, 'verify_command_required');
  assert.equal(writeTaskReceipt({ command: 'true', root, runner }).reason, 'task_id_required');
  assert.equal(writeTaskReceipt({ taskId: 'empty', command: '', root, runner }).reason, 'verify_command_required');
  assert.equal(calls, 0);

  const { scrubAgentEnv } = require('../../test/helpers/agent-env');
  const cli = path.resolve(__dirname, '../../bin/atris.js');
  const env = { ...scrubAgentEnv(), ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
    ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  const init = run(['init', '--minimal', '--yes']);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const added = run(['task', 'add', 'Keep refused checks outside review', '--json']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const ref = JSON.parse(added.stdout).task.display_id;
  const sentinel = path.join(root, 'cli-ran.txt');
  const command = `printf ran > ${quote(sentinel)}`;
  for (const [name, args] of [
    ['ready', ['task', 'ready', ref, '--verify', command, '--result',
      'Operators can see why the check could not run, so they can choose a usable node folder.']],
    ['receipt text', ['task', 'receipt', ref, '--verify', command]],
    ['receipt json', ['task', 'receipt', ref, '--verify', command, '--json']],
  ]) {
    const result = run(args);
    const output = (result.stdout + result.stderr).trim();
    assert.equal(result.status, 1, output);
    assert.ok(output.includes('could not run the check because the node folder contains a colon'), output);
    assert.ok(!output.includes('undefined'), output);
    assert.equal(fs.existsSync(sentinel), false);
    if (name === 'receipt json') {
      const json = JSON.parse(result.stdout);
      assert.equal(json.passed, false);
      assert.equal(json.reason, 'caller_runtime_path_unsupported');
      assert.equal(json.exit, undefined);
      assert.equal(json.receipt_path, undefined);
    } else {
      assert.ok(!output.includes('receipt written:'), output);
      assert.ok(!output.includes('(exit '), output);
    }
    console.log(`${name}: actual CLI exit 1; no check side effect`);
    console.log(output);
  }
  const runs = path.join(root, 'atris', 'runs');
  assert.ok(!fs.existsSync(runs) || fs.readdirSync(runs).length === 0);
  const listed = run(['task', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.ok(!listed.stdout.includes('"status": "review"'));
  console.log('both real runners refused; three actual CLI calls explained refusal; no receipt or review transition');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-paired-runtime-'));
  try {
    const caller = path.join(root, "caller node's:bin");
    const competitor = path.join(root, 'competing');
    fs.mkdirSync(caller);
    fs.mkdirSync(competitor);
    const libraries = path.resolve(path.dirname(process.execPath), '../lib');
    if (process.platform === 'darwin' && fs.existsSync(libraries)) {
      fs.symlinkSync(libraries, path.join(root, 'lib'), 'dir');
    }
    fs.writeFileSync(path.join(competitor, 'node'), '#!/bin/sh\nprintf competing-node\n', { mode: 0o755 });
    const binary = path.join(caller, path.basename(process.execPath));
    fs.copyFileSync(process.execPath, binary);
    fs.chmodSync(binary, 0o755);
    const child = spawnSync(binary, [__filename, '--child', root], { encoding: 'utf8', timeout: 120000 });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
  } finally {
    // Remove only this invocation's generated fixture, including its receipts.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
