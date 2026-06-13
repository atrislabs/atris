'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { resolveClaudeRunnerModel, detectUnavailableModel, missionPauseNextAction } = require('../commands/mission');

// --- resolveClaudeRunnerModel: precedence explicit > env > default alias ---

test('resolveClaudeRunnerModel honors explicit mission.model first', () => {
  const prev = process.env.ATRIS_CLAUDE_MODEL;
  process.env.ATRIS_CLAUDE_MODEL = 'sonnet';
  try {
    assert.equal(resolveClaudeRunnerModel({ model: 'claude-opus-4-8' }), 'claude-opus-4-8');
  } finally {
    if (prev === undefined) delete process.env.ATRIS_CLAUDE_MODEL; else process.env.ATRIS_CLAUDE_MODEL = prev;
  }
});

test('resolveClaudeRunnerModel falls back to ATRIS_CLAUDE_MODEL env when no mission.model', () => {
  const prev = process.env.ATRIS_CLAUDE_MODEL;
  process.env.ATRIS_CLAUDE_MODEL = 'sonnet';
  try {
    assert.equal(resolveClaudeRunnerModel({ model: null }), 'sonnet');
    assert.equal(resolveClaudeRunnerModel({}), 'sonnet');
  } finally {
    if (prev === undefined) delete process.env.ATRIS_CLAUDE_MODEL; else process.env.ATRIS_CLAUDE_MODEL = prev;
  }
});

test('resolveClaudeRunnerModel defaults to the opus alias (never a retired versioned id)', () => {
  const prev = process.env.ATRIS_CLAUDE_MODEL;
  delete process.env.ATRIS_CLAUDE_MODEL;
  try {
    assert.equal(resolveClaudeRunnerModel({ model: null }), 'opus');
    assert.equal(resolveClaudeRunnerModel({}), 'opus');
    assert.equal(resolveClaudeRunnerModel({ model: '   ' }), 'opus');
  } finally {
    if (prev !== undefined) process.env.ATRIS_CLAUDE_MODEL = prev;
  }
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
  assert.match(action, /mission\.model or ATRIS_CLAUDE_MODEL/);
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
