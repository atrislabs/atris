'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packageScriptEnv } = require('../lib/spawn-env');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-script-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const realBin = path.join(dir, 'package-manager');
  fs.writeFileSync(realBin, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CALL_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(process.env.CONFIG_OUTPUT || '');
process.exitCode = Number(process.env.CONFIG_STATUS || 0);
`, { mode: 0o700 });
  return {
    dir,
    realBin,
    scriptShell: path.join(dir, 'guard-shell'),
    env: { HOME: dir, CALL_FILE: path.join(dir, 'call.json') },
  };
}

test('uses the configured shell and forwards only relevant config flags before --', t => {
  const f = fixture(t);
  const env = { ...f.env, CONFIG_OUTPUT: 'config notice\n  /configured/shell  \n', KEEP: 'value' };
  const before = { ...env };
  const result = packageScriptEnv({ tool: 'yarn', ...f }, env, f.dir,
    ['run', 'build', '--cwd', f.dir, '--use-yarnrc=local.rc', '--prefix', 'ignored', '--', '--cwd', 'ignored']);

  assert.deepStrictEqual(result, {
    ...env,
    npm_config_script_shell: f.scriptShell,
    YARN_SCRIPT_SHELL: f.scriptShell,
    ATRIS_SCRIPT_SHELL: '/configured/shell',
  });
  assert.deepStrictEqual(env, before);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.CALL_FILE, 'utf8')), {
    args: ['--cwd', f.dir, '--use-yarnrc=local.rc', 'config', 'get', 'script-shell'],
    cwd: fs.realpathSync(f.dir),
  });
});

test('nested pnpm calls preserve the outer shell without invoking the executable', t => {
  const f = fixture(t);
  const env = { ...f.env, npm_config_script_shell: f.scriptShell, ATRIS_SCRIPT_SHELL: '/outer/shell', npm_config_shell_emulator: 'true' };
  const result = packageScriptEnv({ tool: 'pnpm', ...f, realBin: path.join(f.dir, 'missing') }, env, f.dir);

  assert.deepStrictEqual(result, { ...env, npm_config_shell_emulator: 'false' });
  assert.notStrictEqual(result, env);
  assert.strictEqual(env.npm_config_shell_emulator, 'true');
  assert.strictEqual(fs.existsSync(env.CALL_FILE), false);
});

test('empty, sentinel, recursive, and failed config results remove a stale shell', t => {
  const f = fixture(t);
  for (const [output, status] of [['', '0'], ['null\n', '0'], ['undefined\n', '0'], [f.scriptShell, '0'], ['/failed/shell', '1']]) {
    const env = { ...f.env, CONFIG_OUTPUT: output, CONFIG_STATUS: status, ATRIS_SCRIPT_SHELL: '/stale/shell' };
    const result = packageScriptEnv({ tool: 'npm', ...f }, env, f.dir);
    const expected = { ...env, npm_config_script_shell: f.scriptShell };
    delete expected.ATRIS_SCRIPT_SHELL;
    assert.deepStrictEqual(result, expected);
    assert.strictEqual(env.ATRIS_SCRIPT_SHELL, '/stale/shell');
  }
});
