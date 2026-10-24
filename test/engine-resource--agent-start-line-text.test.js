'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { agentStartLineText } = require('../lib/engine-resource');

test('a startup hit with a fix names the file, the line, and the guarded change', () => {
  const text = agentStartLineText({
    file: '~/.zshrc',
    line: 1,
    fix: '[ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"',
  });
  assert.strictEqual(
    text,
    'likely source: ~/.zshrc line 1 starts a new ssh-agent in every shell that reads it; to start one only when none is reachable, change it to: [ -S "$SSH_AUTH_SOCK" ] || eval "$(ssh-agent -s)"',
  );
});

test('a startup hit with no fix names only the source line', () => {
  const text = agentStartLineText({ file: '~/.zprofile', line: 40 });
  assert.strictEqual(
    text,
    'likely source: ~/.zprofile line 40 starts a new ssh-agent in every shell that reads it',
  );
});

test('an empty fix is left off, and a missing argument throws', () => {
  assert.strictEqual(
    agentStartLineText({ file: '', line: 0, fix: '' }),
    'likely source:  line 0 starts a new ssh-agent in every shell that reads it',
  );
  assert.throws(() => agentStartLineText(), TypeError);
});
