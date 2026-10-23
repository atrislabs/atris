'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  callerRuntime,
  runHasLiveCodexSession,
  defaultObjectiveRunner,
} = require('../lib/default-runner');

test('defaultObjectiveRunner stays on claude unless a live codex session is driving', () => {
  assert.equal(defaultObjectiveRunner([], {}), 'claude');
  assert.equal(defaultObjectiveRunner(null, {}), 'claude');
  assert.equal(defaultObjectiveRunner([], { CLAUDECODE: '1' }), 'claude');
  assert.equal(defaultObjectiveRunner([], { ATRIS_CALLER_RUNTIME: 'agent' }), 'claude');
  assert.equal(defaultObjectiveRunner([], { ATRIS_CALLER_RUNTIME: 'terminal' }), 'claude');
  assert.equal(defaultObjectiveRunner([], { CODEX_THREAD_ID: '   ' }), 'claude');
  assert.equal(defaultObjectiveRunner(['--native-goal-status'], {}), 'claude');
  assert.equal(defaultObjectiveRunner(['--native-goal-status='], {}), 'claude');
  assert.equal(defaultObjectiveRunner(['--native-goal-status', ''], {}), 'claude');
  assert.equal(
    defaultObjectiveRunner([], { ATRIS_CALLER_RUNTIME: 'agent', CODEX_THREAD_ID: 'thread-1' }),
    'claude',
  );

  assert.equal(defaultObjectiveRunner([], { ATRIS_CALLER_RUNTIME: 'codex' }), 'codex_goal');
  assert.equal(defaultObjectiveRunner([], { ATRIS_CALLER_RUNTIME: 'CODEX' }), 'codex_goal');
  assert.equal(defaultObjectiveRunner([], { CODEX_THREAD_ID: 'thread-1' }), 'codex_goal');
  assert.equal(defaultObjectiveRunner([], { CODEX_SESSION_ID: 'sess-1' }), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--native-goal-status', 'running'], {}), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--native-goal-status=running'], {}), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--native-goal-status', '0'], {}), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--visible-goal-status', 'active'], {}), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--native-goal-objective', 'ship it'], {}), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--visible-goal-objective=see it'], {}), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--take-goal-slot'], { ATRIS_CALLER_RUNTIME: 'terminal' }), 'codex_goal');
  assert.equal(defaultObjectiveRunner(['--take-goal-slot=1'], {}), 'codex_goal');
});

test('callerRuntime names codex, agent, or terminal from the flags and the environment', () => {
  assert.equal(callerRuntime([], {}), 'terminal');
  assert.equal(callerRuntime(undefined, {}), 'terminal');
  assert.equal(callerRuntime([], { ATRIS_CALLER_RUNTIME: 'nope' }), 'terminal');
  assert.equal(callerRuntime([], { ATRIS_CALLER_RUNTIME: 'terminal', CLAUDECODE: '1' }), 'terminal');
  assert.equal(callerRuntime([], { CLAUDECODE: '   ' }), 'terminal');

  assert.equal(callerRuntime([], { CLAUDECODE: '1' }), 'agent');
  assert.equal(callerRuntime([], { CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'agent');
  assert.equal(callerRuntime([], { CURSOR_AGENT: '1' }), 'agent');
  assert.equal(callerRuntime([], { DEVIN_SESSION_ID: 'd1' }), 'agent');
  assert.equal(callerRuntime([], { ATRIS_CALLER_RUNTIME: 'agent' }), 'agent');
  assert.equal(callerRuntime([], { ATRIS_CALLER_RUNTIME: ' Agent ' }), 'agent');

  assert.equal(callerRuntime([], { CODEX_THREAD_ID: 't' }), 'codex');
  assert.equal(callerRuntime([], { CODEX_SESSION_ID: 's' }), 'codex');
  assert.equal(callerRuntime(['--take-goal-slot'], { ATRIS_CALLER_RUNTIME: 'terminal' }), 'codex');
  assert.equal(callerRuntime(['--take-goal-slot'], { ATRIS_CALLER_RUNTIME: 'agent' }), 'codex');
  assert.equal(callerRuntime(['--visible-goal-objective', 'see it'], { CURSOR_AGENT: '1' }), 'codex');
});

test('runHasLiveCodexSession is true only when a codex session is actually on the other end', () => {
  assert.equal(runHasLiveCodexSession([], {}), false);
  assert.equal(runHasLiveCodexSession(['--take-goal-slot-extra'], {}), false);
  assert.equal(runHasLiveCodexSession(['--native-goal-objective='], { DEVIN_SESSION_ID: 'd' }), false);
  assert.equal(
    runHasLiveCodexSession([], { ATRIS_CALLER_RUNTIME: 'terminal', CODEX_THREAD_ID: 't' }),
    false,
  );

  assert.equal(runHasLiveCodexSession(['--other', '--take-goal-slot'], {}), true);
  assert.equal(runHasLiveCodexSession([], { CODEX_SESSION_ID: 's' }), true);
  assert.equal(runHasLiveCodexSession([], { ATRIS_CALLER_RUNTIME: 'codex' }), true);
  assert.equal(runHasLiveCodexSession(['--visible-goal-status=active'], {}), true);
});
