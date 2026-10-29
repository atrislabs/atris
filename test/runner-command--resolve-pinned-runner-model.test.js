'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolvePinnedRunnerModel } = require('../lib/runner-command');

function withRunnerEnv(values, check) {
  const keys = ['ATRIS_CLAUDE_SPEND_OK', 'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_CLAUDE_MODEL'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    check();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('explicit models are trimmed and take precedence without normalization', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'fable', ATRIS_CLAUDE_SPEND_OK: 'opus 5.5' }, () => {
    assert.strictEqual(resolvePinnedRunnerModel({ model: '  provider/custom-model \n' }), 'provider/custom-model');
    assert.strictEqual(resolvePinnedRunnerModel({ model: ' opus 5.5 ' }), 'opus 5.5');
    assert.strictEqual(resolvePinnedRunnerModel({ model: 0 }), '0');
  });
});

test('missing and blank models fall back to the selected profile pin', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: ' fable ', ATRIS_CLAUDE_SPEND_OK: 'claude-fable-5-1' }, () => {
    for (const mission of [undefined, null, {}, { model: null }, { model: '' }, { model: ' \t\n' }]) {
      assert.strictEqual(resolvePinnedRunnerModel(mission), 'claude-fable-5-1');
    }
  });
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'atris2-fast' }, () => {
    assert.strictEqual(resolvePinnedRunnerModel({}), 'atris:fast');
  });
});

test('unpinned profiles and absent profiles return empty despite model environment overrides', () => {
  withRunnerEnv({ ATRIS_RUNNER_MODEL: 'runner-env-model', ATRIS_CLAUDE_MODEL: 'legacy-env-model', ATRIS_CLAUDE_SPEND_OK: 'claude-fable-5-1' }, () => {
    assert.strictEqual(resolvePinnedRunnerModel(), '');
    assert.strictEqual(resolvePinnedRunnerModel({ model: ' ' }), '');
    process.env.ATRIS_RUNNER_PROFILE = 'codex';
    assert.strictEqual(resolvePinnedRunnerModel({}), '');
    process.env.ATRIS_RUNNER_PROFILE = 'fable';
    assert.strictEqual(resolvePinnedRunnerModel({}), 'claude-fable-5-1');
  });
});

test('invalid profiles throw only when an explicit model does not bypass profile lookup', () => {
  withRunnerEnv({ ATRIS_RUNNER_PROFILE: 'nonexistent-test-profile' }, () => {
    assert.throws(() => resolvePinnedRunnerModel({ model: ' ' }), {
      name: 'Error',
      message: /^Unknown ATRIS_RUNNER_PROFILE "nonexistent-test-profile"\. Known profiles: /,
    });
    assert.strictEqual(resolvePinnedRunnerModel({ model: ' explicit-model ' }), 'explicit-model');
  });
});
