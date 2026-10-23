'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  CLAUDE_FAMILY_ENGINES,
  CLAUDE_MODEL_ALIASES,
  RETIRED_CLAUDE_MODELS,
  currentClaudeModel,
  claudeModelId,
  retiredModelsNamed,
  normalizeRosterModel,
  savedRosterModel,
} = require('../lib/model-names');

test('claudeModelId turns display names into claude cli ids', () => {
  assert.strictEqual(claudeModelId('opus 5.5'), 'claude-opus-5-5');
  assert.strictEqual(claudeModelId('fable 5.1'), 'claude-fable-5-1');
  assert.strictEqual(claudeModelId('Sonnet 5'), 'claude-sonnet-5');
  assert.strictEqual(claudeModelId('opus'), 'opus');
  assert.strictEqual(claudeModelId('claude-sonnet-5-2'), 'claude-sonnet-5-2');
});

test('claudeModelId maps retired models to their replacements and keeps [1m]', () => {
  assert.strictEqual(claudeModelId('claude-fable-5'), 'claude-fable-5-1');
  assert.strictEqual(claudeModelId('claude-haiku-4-5'), 'claude-haiku-5-5');
  assert.strictEqual(claudeModelId('claude-haiku-4-5 [1m]'), 'claude-haiku-5-5[1m]');
  assert.strictEqual(claudeModelId('fable 5 [1m]'), 'claude-fable-5-1[1m]');
});

test('currentClaudeModel swaps retired ids and leaves current ids alone', () => {
  assert.strictEqual(currentClaudeModel('claude-haiku-4-5-20251001'), 'claude-haiku-5-5');
  assert.strictEqual(currentClaudeModel('claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.strictEqual(currentClaudeModel('claude-fable-5 [1m]'), 'claude-fable-5-1[1m]');
  assert.strictEqual(currentClaudeModel(''), '');
});

test('normalizeRosterModel accepts aliases, spellings, and ids for claude-family engines', () => {
  for (const engine of CLAUDE_FAMILY_ENGINES) {
    assert.strictEqual(normalizeRosterModel(engine, 'opus'), 'opus');
    assert.strictEqual(normalizeRosterModel(engine, 'opusplan'), 'opusplan');
    assert.strictEqual(normalizeRosterModel(engine, 'opus 5.5'), 'claude-opus-5-5');
    assert.strictEqual(normalizeRosterModel(engine, 'claude-sonnet-5-2'), 'claude-sonnet-5-2');
    assert.strictEqual(normalizeRosterModel(engine, 'haiku 5.5 [1m]'), 'claude-haiku-5-5[1m]');
    assert.strictEqual(normalizeRosterModel(engine, ''), '');
  }
  for (const alias of CLAUDE_MODEL_ALIASES) {
    assert.strictEqual(normalizeRosterModel('claude', alias), alias);
  }
});

test('normalizeRosterModel upgrades retired picks and rejects names claude rejects', () => {
  assert.strictEqual(normalizeRosterModel('claude', 'fable 5'), 'claude-fable-5-1');
  assert.strictEqual(normalizeRosterModel('claude', 'claude-fable-5'), 'claude-fable-5-1');
  assert.throws(
    () => normalizeRosterModel('claude', 'gpt-5'),
    /claude does not know the model "gpt-5"/,
  );
});

test('normalizeRosterModel normalizes grok names and passes other engines through', () => {
  assert.strictEqual(normalizeRosterModel('grok', 'grok 4.7 fast'), 'grok-4.7-build-fast');
  assert.strictEqual(normalizeRosterModel('grok', 'grok 4.7'), 'grok-4.7');
  assert.strictEqual(normalizeRosterModel('grok', 'grok-4.7-build-fast'), 'grok-4.7-build-fast');
  assert.throws(() => normalizeRosterModel('grok', 'opus'), /grok does not know the model/);
  assert.strictEqual(normalizeRosterModel('codex', 'gpt-5-codex'), 'gpt-5-codex');
  assert.strictEqual(normalizeRosterModel('unknown-engine', 'anything-9'), 'anything-9');
});

test('savedRosterModel returns the normalized id or null for a bad saved name', () => {
  assert.strictEqual(savedRosterModel('claude', 'fable 5'), 'claude-fable-5-1');
  assert.strictEqual(savedRosterModel('claude', 'not-a-model'), null);
  assert.strictEqual(savedRosterModel('grok', 'grok 4.7'), 'grok-4.7');
  assert.strictEqual(savedRosterModel('grok', 'claude-9'), null);
  assert.strictEqual(savedRosterModel('codex', ''), '');
});

test('retiredModelsNamed finds retired ids spelled each way, once per base', () => {
  // both haiku spellings normalize to the same reported base id
  assert.deepStrictEqual(
    retiredModelsNamed('haiku 4.5 and claude-haiku-4-5-20251001'),
    ['claude-haiku-4-5'],
  );
  assert.deepStrictEqual(retiredModelsNamed('claude haiku 4.5'), ['claude-haiku-4-5']);
  // a retired id without a minor version is never matched
  assert.deepStrictEqual(retiredModelsNamed('fable 5 claude-fable-5'), []);
  assert.deepStrictEqual(retiredModelsNamed('claude-haiku-5-5 sonnet 5.2'), []);
  assert.deepStrictEqual(retiredModelsNamed('fable 5.1 opus 5.5'), []);
  assert.deepStrictEqual(retiredModelsNamed('haiku 4.5.9'), []);
});

test('exported constant tables stay frozen and list the expected entries', () => {
  assert.deepStrictEqual(CLAUDE_FAMILY_ENGINES, ['claude', 'fable', 'haiku']);
  assert.ok(CLAUDE_MODEL_ALIASES.includes('default'));
  assert.strictEqual(RETIRED_CLAUDE_MODELS['claude-fable-5'], 'claude-fable-5-1');
  assert.throws(() => {
    CLAUDE_FAMILY_ENGINES.push('gpt');
  }, TypeError);
});
