'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveClaudeRunnerModel,
  resolveClaudeRunnerBin,
  composeHumanBlockingPauseMessage,
  detectUnavailableModel,
  escalateHumanBlockingPause,
  missionPauseNextAction,
  consecutiveSameReasonErrors,
} = require('../commands/mission');

const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
];

function withRunnerEnv(values, fn) {
  const prev = new Map(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of RUNNER_ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- resolveClaudeRunnerModel: precedence explicit > env > pinned default ---

test('resolveClaudeRunnerModel honors explicit mission.model first', () => {
  withRunnerEnv({ ATRIS_CLAUDE_MODEL: 'sonnet' }, () => {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-4-8' }), 'claude-opus-4-8');
  });
});

test('resolveClaudeRunnerModel falls back to ATRIS_CLAUDE_MODEL env when no mission.model', () => {
  withRunnerEnv({ ATRIS_CLAUDE_MODEL: 'sonnet' }, () => {
    assert.equal(resolveClaudeRunnerModel({ model: null }), 'sonnet');
    assert.equal(resolveClaudeRunnerModel({}), 'sonnet');
  });
});

test('resolveClaudeRunnerModel prefers ATRIS_RUNNER_MODEL over legacy env', () => {
  withRunnerEnv({ ATRIS_RUNNER_MODEL: 'glm-5.2', ATRIS_CLAUDE_MODEL: 'opus' }, () => {
    assert.equal(resolveClaudeRunnerModel({}), 'glm-5.2');
  });
});

test('resolveClaudeRunnerModel defaults to pinned Opus 4.8', () => {
  withRunnerEnv({}, () => {
    assert.equal(resolveClaudeRunnerModel({ model: null }), 'claude-opus-4-8');
    assert.equal(resolveClaudeRunnerModel({}), 'claude-opus-4-8');
    assert.equal(resolveClaudeRunnerModel({ model: '   ' }), 'claude-opus-4-8');
  });
});

test('resolveClaudeRunnerBin lets missions swap the Claude binary by env', () => {
  withRunnerEnv({ ATRIS_CLAUDE_BIN: '/opt/atris/bin/claude-nightly' }, () => {
    assert.equal(resolveClaudeRunnerBin(), '/opt/atris/bin/claude-nightly');
  });
});

test('resolveClaudeRunnerBin prefers ATRIS_RUNNER_BIN over legacy env', () => {
  withRunnerEnv({ ATRIS_RUNNER_BIN: '/opt/glm/runner', ATRIS_CLAUDE_BIN: '/opt/claude' }, () => {
    assert.equal(resolveClaudeRunnerBin(), '/opt/glm/runner');
  });
});

// --- detectUnavailableModel: turn a buried claude-error into an actionable signal ---

test('detectUnavailableModel extracts the retired model id from the CLI message', () => {
  const msg = "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it. Run --model to pick a different model.";
  assert.equal(detectUnavailableModel(msg), 'claude-fable-5');
});

test('detectUnavailableModel handles the bracketed [1m] variant', () => {
  const msg = 'issue with the selected model (claude-fable-5[1m]). It may not exist or you may not have access to it.';
  assert.equal(detectUnavailableModel(msg), 'claude-fable-5[1m]');
});

test('detectUnavailableModel returns null for ordinary tick output', () => {
  assert.equal(detectUnavailableModel('Shipped one verified change to review. npm test 958/958.'), null);
  assert.equal(detectUnavailableModel(''), null);
  assert.equal(detectUnavailableModel(null), null);
});

// --- missionPauseNextAction: a model-unavailable pause must point at the fix, not a bare resume ---

test('missionPauseNextAction names the dead model and the knobs that change it', () => {
  const action = missionPauseNextAction('model-unavailable', 'mission-abc', 'claude-fable-5');
  assert.match(action, /claude-fable-5/);
  assert.match(action, /mission\.model, ATRIS_RUNNER_MODEL, or legacy ATRIS_CLAUDE_MODEL/);
  assert.match(action, /atris mission run mission-abc/);
});

test('missionPauseNextAction falls back to a bare resume for ordinary pauses', () => {
  assert.equal(
    missionPauseNextAction('consecutive-verifier-fails', 'mission-abc'),
    'resume with: atris mission run mission-abc'
  );
  // model-unavailable but no captured id → no actionable model name, so bare resume
  assert.equal(
    missionPauseNextAction('model-unavailable', 'mission-abc', null),
    'resume with: atris mission run mission-abc'
  );
});

test('missionPauseNextAction names the failing reason for a repeated-error pause', () => {
  const action = missionPauseNextAction('repeated-error:claude-timeout', 'mission-abc');
  assert.match(action, /claude-timeout/);
  assert.match(action, /inspect the last receipt/);
  assert.match(action, /atris mission run mission-abc/);
});

test('human-blocking pause escalation message names cause and resume command', () => {
  const message = composeHumanBlockingPauseMessage(
    { id: 'mission-abc' },
    'auth-required',
  );
  assert.match(message, /Mission mission-abc paused: auth-required/);
  assert.match(message, /operator to log in/);
  assert.match(message, /Resume: atris mission run mission-abc/);
});

test('human-blocking pause escalation sends once per paused timestamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pause-escalation-test-'));
  try {
    let sendCount = 0;
    const mission = {
      id: 'mission-abc',
      owner: 'mission-lead',
      status: 'paused',
      paused_at: '2026-07-06T12:00:00.000Z',
      stop_reason: 'auth-required',
    };
    const first = escalateHumanBlockingPause(mission, dir, {
      policy: { imessage_to: '+15555550123' },
      sendImessage: () => {
        sendCount += 1;
        return { ok: true, output: '' };
      },
      now: '2026-07-06T12:00:01.000Z',
    });
    assert.equal(first.escalated, true);
    assert.equal(first.channel, 'imessage');
    assert.equal(first.mission.human_blocking_pause_escalation.sent, true);

    const second = escalateHumanBlockingPause(first.mission, dir, {
      policy: { imessage_to: '+15555550123' },
      sendImessage: () => {
        sendCount += 1;
        return { ok: true, output: '' };
      },
      now: '2026-07-06T12:00:02.000Z',
    });
    assert.equal(second.escalated, false);
    assert.equal(second.skipped, 'already-escalated');
    assert.equal(sendCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missionPauseNextAction points at the cause when max-ticks is hit on an errored tick', () => {
  // single-tick cron runs pause as max-ticks-reached on the first errored tick
  const action = missionPauseNextAction('max-ticks-reached', 'mission-abc', null, 'claude-error');
  assert.match(action, /claude-error/);
  assert.match(action, /inspect the last receipt before resuming/);
  assert.match(action, /atris mission run mission-abc/);
});

test('missionPauseNextAction is a bare resume when max-ticks is hit without an error reason', () => {
  // budget exhausted after clean ticks → a plain resume is the right advice
  assert.equal(
    missionPauseNextAction('max-ticks-reached', 'mission-abc', null, null),
    'resume with: atris mission run mission-abc'
  );
});

// --- consecutiveSameReasonErrors: two identical failures in a row halts the loop ---

test('consecutiveSameReasonErrors counts the trailing run of identical error reasons', () => {
  const ticks = [
    { status: 'ran' },
    { status: 'errored', reason: 'claude-timeout' },
    { status: 'errored', reason: 'claude-timeout' },
  ];
  assert.deepEqual(consecutiveSameReasonErrors(ticks), { reason: 'claude-timeout', count: 2 });
});

test('consecutiveSameReasonErrors resets when the latest error reason differs', () => {
  const ticks = [
    { status: 'errored', reason: 'claude-timeout' },
    { status: 'errored', reason: 'atris2-error' },
  ];
  assert.deepEqual(consecutiveSameReasonErrors(ticks), { reason: 'atris2-error', count: 1 });
});

test('consecutiveSameReasonErrors breaks the streak on an intervening ran tick', () => {
  const ticks = [
    { status: 'errored', reason: 'claude-timeout' },
    { status: 'ran' },
    { status: 'errored', reason: 'claude-timeout' },
  ];
  assert.deepEqual(consecutiveSameReasonErrors(ticks), { reason: 'claude-timeout', count: 1 });
});

test('consecutiveSameReasonErrors returns zero when the last tick is not an error', () => {
  assert.deepEqual(consecutiveSameReasonErrors([{ status: 'errored', reason: 'x' }, { status: 'ran' }]), { reason: null, count: 0 });
  assert.deepEqual(consecutiveSameReasonErrors([]), { reason: null, count: 0 });
});
