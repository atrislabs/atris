'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeCliRunner } = require('../lib/gm-bet');

function fixture(t, source, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-cli-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cliPath = path.join(root, 'local cli.js');
  fs.writeFileSync(cliPath, source);
  // Pass a complete environment rather than inheriting machine-specific settings.
  const env = { HOME: root, ...extraEnv };
  return { root, env, run: makeCliRunner({ cliPath, cwd: root, env }) };
}

test('makeCliRunner runs Node in the requested directory with literal arguments and explicit environment', async t => {
  const { root, env, run } = fixture(t, `
    process.stdout.write(JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      home: process.env.HOME,
      marker: process.env.LOCAL_MARKER,
      skipUpdate: process.env.ATRIS_SKIP_UPDATE_CHECK
    }));
    process.stderr.write('local diagnostic\\n');
  `, { LOCAL_MARKER: 'fixture value', ATRIS_SKIP_UPDATE_CHECK: '0' });
  const args = ['mission', 'two words', '$(echo unsafe); *', '--flag=value'];
  const result = await run(args);

  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(JSON.parse(result.stdout), {
    args,
    cwd: fs.realpathSync(root),
    home: root,
    marker: 'fixture value',
    skipUpdate: '1',
  });
  assert.strictEqual(result.stderr, 'local diagnostic\n');
  assert.strictEqual(env.ATRIS_SKIP_UPDATE_CHECK, '0');
});

test('makeCliRunner accepts no arguments and returns empty strings for silent success', async t => {
  const { run } = fixture(t, `
    if (process.argv.length !== 2) process.exit(9);
  `);

  assert.deepStrictEqual(await run([]), { code: 0, stdout: '', stderr: '' });
  assert.deepStrictEqual(await run([]), { code: 0, stdout: '', stderr: '' });
});

test('makeCliRunner resolves a failed command with its exit code and both output streams', async t => {
  const { run } = fixture(t, `
    process.stdout.write('partial result\\n');
    process.stderr.write('input rejected\\n');
    process.exitCode = 7;
  `);

  assert.deepStrictEqual(await run(['invalid']), {
    code: 7,
    stdout: 'partial result\n',
    stderr: 'input rejected\n',
  });
});
