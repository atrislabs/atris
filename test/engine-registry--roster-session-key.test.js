'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rosterSessionKey } = require('../lib/engine-registry');

function withSessionEnvironment(named, run) {
  const names = ['ATRIS_ROSTER_SESSION', 'NODE_TEST_CONTEXT'];
  const saved = names.map((name) => process.env[name]);
  delete process.env.ATRIS_ROSTER_SESSION;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  if (named !== undefined) process.env.ATRIS_ROSTER_SESSION = named;
  try {
    run();
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}

test('explicit session keys are trimmed and take precedence over the environment', () => {
  withSessionEnvironment('environment-session', () => {
    assert.strictEqual(rosterSessionKey({ sessionKey: '  project/session-1\n' }), 'project/session-1');
    assert.strictEqual(rosterSessionKey({ sessionKey: 42 }), '42');
  });
});

test('explicit empty and falsy keys suppress the environment session', () => {
  withSessionEnvironment('environment-session', () => {
    for (const sessionKey of ['', ' \t\n', null, false, 0]) {
      assert.strictEqual(rosterSessionKey({ sessionKey }), '');
    }
  });
});

test('a named environment session is trimmed when the explicit key is absent', () => {
  withSessionEnvironment(' \tshared-session\n', () => {
    assert.strictEqual(rosterSessionKey(), 'shared-session');
    assert.strictEqual(rosterSessionKey({}), 'shared-session');
    assert.strictEqual(rosterSessionKey({ sessionKey: undefined }), 'shared-session');
  });
});

test('test runs without a nonempty named session return an empty key', () => {
  withSessionEnvironment(undefined, () => {
    assert.strictEqual(rosterSessionKey(), '');
  });
  withSessionEnvironment(' \t\n', () => {
    assert.strictEqual(rosterSessionKey({}), '');
  });
});
