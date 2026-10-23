'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeStepRunner } = require('../lib/gm-phone');

// Everything this file writes lives under one fresh temp dir, removed at the end.
// makeStepRunner runs a stub script instead of the real atris CLI, so no engine,
// network, or workspace is involved.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-step-runner-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const stub = path.join(root, 'stub-cli.js');
fs.writeFileSync(stub, [
  'const args = process.argv.slice(2);',
  'if (args[0] === "silent") process.exit(0);',
  'if (args[0] === "long") { console.log("x".repeat(300)); process.exit(0); }',
  'if (args[0] === "env") { console.log(process.env.ATRIS_SKIP_UPDATE_CHECK); process.exit(0); }',
  'console.log("first line");',
  'console.log(JSON.stringify(args));',
  'if (args[0] === "fail") { console.error("boom: " + args.join(" ")); process.exit(3); }',
  'process.exit(0);',
].join('\n'));

test('runs the command with its args and reports exit code and last output line', async () => {
  const logDir = path.join(root, 'runs-normal');
  const runStep = makeStepRunner({ cliPath: stub, cwd: root, logDir });

  const result = await runStep(['task', 'accept', 't1']);

  assert.deepStrictEqual(result, { code: 0, last_line: '["task","accept","t1"]' });
  const logs = fs.readdirSync(logDir);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(logDir, logs[0]), 'utf8'),
    'first line\n["task","accept","t1"]\n',
  );
});

test('a failing command reports its exit code and the last line it printed', async () => {
  const logDir = path.join(root, 'runs-fail');
  const runStep = makeStepRunner({ cliPath: stub, cwd: root, logDir });

  const result = await runStep(['fail', 'x']);

  assert.deepStrictEqual(result, { code: 3, last_line: 'boom: fail x' });
});

test('a command with no output reports an empty last line', async () => {
  const logDir = path.join(root, 'runs-silent');
  const runStep = makeStepRunner({ cliPath: stub, cwd: root, logDir });

  const result = await runStep(['silent']);

  assert.deepStrictEqual(result, { code: 0, last_line: '' });
});

test('the last line is cut to 160 characters', async () => {
  const logDir = path.join(root, 'runs-long');
  const runStep = makeStepRunner({ cliPath: stub, cwd: root, logDir });

  const result = await runStep(['long']);

  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.last_line, 'x'.repeat(160));
});

test('the child gets ATRIS_SKIP_UPDATE_CHECK=1 whatever the parent env says', async () => {
  const prior = process.env.ATRIS_SKIP_UPDATE_CHECK;
  process.env.ATRIS_SKIP_UPDATE_CHECK = '0';
  try {
    const runStep = makeStepRunner({ cliPath: stub, cwd: root, logDir: path.join(root, 'runs-env') });

    const result = await runStep(['env']);

    assert.deepStrictEqual(result, { code: 0, last_line: '1' });
  } finally {
    if (prior === undefined) delete process.env.ATRIS_SKIP_UPDATE_CHECK;
    else process.env.ATRIS_SKIP_UPDATE_CHECK = prior;
  }
});

test('a missing working directory resolves to code 1 with the spawn error, never rejects', async () => {
  const logDir = path.join(root, 'runs-no-cwd');
  const runStep = makeStepRunner({ cliPath: stub, cwd: path.join(root, 'does-not-exist'), logDir });

  const result = await runStep(['task', 'accept', 't1']);

  assert.strictEqual(result.code, 1);
  assert.match(result.last_line, /ENOENT/);
});

test('the log directory is created when it does not exist yet', async () => {
  const logDir = path.join(root, 'nested', 'deeper', 'gm-phone-runs');
  assert.strictEqual(fs.existsSync(logDir), false);
  const runStep = makeStepRunner({ cliPath: stub, cwd: root, logDir });

  const result = await runStep(['task', 'accept', 't2']);

  assert.strictEqual(result.code, 0);
  assert.strictEqual(fs.readdirSync(logDir).length, 1);
});
