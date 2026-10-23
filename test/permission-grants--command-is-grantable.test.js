'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { commandIsGrantable } = require('../lib/permission-grants');

test('allows plain commands and trims surrounding whitespace', () => {
  for (const command of ['git status', 'node --test test/example.test.js', '\t git status \n']) {
    assert.deepStrictEqual(commandIsGrantable(command), { ok: true }, command);
  }
});

test('rejects empty and missing commands', () => {
  for (const command of ['', ' \t\r\n ', undefined, null, false, 0]) {
    assert.deepStrictEqual(commandIsGrantable(command), {
      ok: false,
      reason: 'empty command',
    });
  }
  assert.deepStrictEqual(commandIsGrantable(), { ok: false, reason: 'empty command' });
});

test('rejects shell metacharacters even inside quoted text', () => {
  for (const character of [';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}',
    '[', ']', '*', '?', '~', '\\', '\n', '\r']) {
    const command = `echo a${character}b`;
    assert.deepStrictEqual(commandIsGrantable(command), {
      ok: false,
      reason: 'shell metacharacters are never grantable',
    }, JSON.stringify(command));
  }
  assert.deepStrictEqual(commandIsGrantable('echo "hello;world"'), {
    ok: false,
    reason: 'shell metacharacters are never grantable',
  });
});

test('rejects commands covered by each always-ask rule', () => {
  for (const command of [
    'sudo git status',
    'rm -rf build ',
    'git push origin main --force',
    'git reset --hard',
    'bash -c echo',
    'sh -c echo',
    'zsh -c echo',
    'node -e 1',
    'python -c pass',
    'python3 -c pass',
    'chmod 755 script.js',
    'chown user file',
    'cat credentials.json',
    'cat .ssh/config',
    'cat .env',
    'atris task accept example',
    'atris autoland policy',
  ]) {
    const result = commandIsGrantable(command);
    assert.strictEqual(result.ok, false, command);
    assert.match(result.reason, /^never grantable: matches /, command);
  }
});

test('word boundaries allow similar harmless command names', () => {
  for (const command of ['sudoku solve', 'git reset --soft', 'node --version',
    'python3 --version', 'echo chmodding', 'cat .environment']) {
    assert.deepStrictEqual(commandIsGrantable(command), { ok: true }, command);
  }
});
