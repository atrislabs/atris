'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { missionRunnerNeedsLiveSession } = require('../commands/mission');

test('manual and codex goal runners need a live session', () => {
  for (const runner of ['manual', 'codex_goal', 'MANUAL', 'CoDeX_GoAl']) {
    assert.strictEqual(missionRunnerNeedsLiveSession(runner), true, runner);
  }
});

test('other runner names do not need a live session', () => {
  for (const runner of ['claude', 'auto', 'atris2', 'caller_session', 'current_agent', 'drill', 'unknown']) {
    assert.strictEqual(missionRunnerNeedsLiveSession(runner), false, runner);
  }
});

test('runner names are not trimmed before matching', () => {
  for (const runner of [' manual', 'manual ', ' codex_goal ', ' ']) {
    assert.strictEqual(missionRunnerNeedsLiveSession(runner), false, JSON.stringify(runner));
  }
});

test('missing and empty runner values need a live session', () => {
  assert.strictEqual(missionRunnerNeedsLiveSession(), true);
  for (const runner of [undefined, null, '', false, 0]) {
    assert.strictEqual(missionRunnerNeedsLiveSession(runner), true, String(runner));
  }
});
