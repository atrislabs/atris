'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const noninteractive = require('../lib/noninteractive');

function setHeadlessEnv(t, value) {
  for (const name of ['ATRIS_NONINTERACTIVE', 'ATRIS_NO_INTERACTIVE']) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    delete process.env[name];
  }
  if (value !== undefined) process.env.ATRIS_NONINTERACTIVE = value;
}

test('either environment alias enables headless mode except empty, zero, or false', () => {
  assert.strictEqual(noninteractive.envForcesNonInteractive({}), false);
  for (const name of ['ATRIS_NONINTERACTIVE', 'ATRIS_NO_INTERACTIVE']) {
    for (const value of ['', '  ', '0', ' false ', 'FALSE']) {
      assert.strictEqual(noninteractive.envForcesNonInteractive({ [name]: value }), false);
    }
    for (const value of ['1', 'true', ' yes ', 'anything']) {
      assert.strictEqual(noninteractive.envForcesNonInteractive({ [name]: value }), true);
    }
  }
  assert.strictEqual(noninteractive.envForcesNonInteractive({
    ATRIS_NONINTERACTIVE: 'false', ATRIS_NO_INTERACTIVE: '1',
  }), true);
});

test('proceed and JSON flags force noninteractive mode with exact token matching', (t) => {
  setHeadlessEnv(t);
  for (const flag of ['--yes', '-y', '--json']) {
    assert.strictEqual(noninteractive.isForcedNonInteractive(['command', flag]), true);
  }
  for (const args of [[], ['--yes=false'], ['--json=true'], ['--once'], null, '--yes']) {
    assert.strictEqual(noninteractive.isForcedNonInteractive(args), false);
  }
  process.env.ATRIS_NO_INTERACTIVE = ' true ';
  assert.strictEqual(noninteractive.isForcedNonInteractive([]), true);
  assert.strictEqual(noninteractive.isNonInteractive([]), true);
});

test('help, JSON, and yes helpers recognize only supported whole tokens', () => {
  for (const token of ['--help', '-h', 'help', '-?']) {
    assert.strictEqual(noninteractive.isHelpToken(token), true);
    assert.strictEqual(noninteractive.argsWantHelp(['command', token]), true);
  }
  for (const token of ['--help=true', 'HELP', 'helpful', undefined]) {
    assert.strictEqual(noninteractive.isHelpToken(token), false);
    assert.strictEqual(noninteractive.argsWantHelp([token]), false);
  }
  assert.strictEqual(noninteractive.argsWantHelp(null), false);
  assert.strictEqual(noninteractive.wantsJson(['--json']), true);
  assert.strictEqual(noninteractive.wantsJson('--json'), false);
  assert.strictEqual(noninteractive.wantsJson(['--json=true']), false);
  assert.strictEqual(noninteractive.hasYesFlag(['--yes']), true);
  assert.strictEqual(noninteractive.hasYesFlag(['-y']), true);
  assert.strictEqual(noninteractive.hasYesFlag(['--yes=false']), false);
  assert.strictEqual(noninteractive.hasYesFlag(null), false);
});

test('headless guard refuses with guidance and honors configured proceed flags', (t) => {
  setHeadlessEnv(t, '1');
  const errors = t.mock.method(console, 'error', () => {});
  assert.strictEqual(noninteractive.refuseHeadlessUnless([]), true);
  assert.deepStrictEqual(errors.mock.calls[0].arguments, [
    'This command needs a terminal, or an explicit proceed flag.\nPass --yes to run headless.',
  ]);
  for (const flag of ['--yes', '-y']) {
    assert.strictEqual(noninteractive.refuseHeadlessUnless([flag]), false);
  }
  assert.strictEqual(noninteractive.refuseHeadlessUnless(['--once'], { allowOnce: true }), false);
  assert.strictEqual(errors.mock.callCount(), 1);
  assert.strictEqual(noninteractive.refuseHeadlessUnless(['--yes'], {
    allowYes: false, allowOnce: true, usage: 'usage: atris serve',
  }), true);
  assert.deepStrictEqual(errors.mock.calls[1].arguments, [
    'usage: atris serve\nPass --yes to run headless, or --once for a single serve op.',
  ]);
  assert.strictEqual(noninteractive.refuseHeadlessUnless(['--once']), true);
});
