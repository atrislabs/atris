const test = require('node:test');
const assert = require('node:assert/strict');
const { missionVerifierTimeoutMs } = require('../lib/default-verifier');

test('zero timeout configuration falls back to the default window', () => {
  assert.strictEqual(
    missionVerifierTimeoutMs({ ATRIS_MISSION_VERIFIER_TIMEOUT_MS: '0' }),
    missionVerifierTimeoutMs({}),
  );
});
