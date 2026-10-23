'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-prep-brief-'));
test.after(() => {
  try {
    fs.rmSync(scratchHome, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

process.env.HOME = scratchHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

const { withPrepBrief } = require('../lib/roster-prep');

test('appends prep pass brief and instructions to a worker prompt', () => {
  assert.strictEqual(typeof withPrepBrief, 'function');

  const basePrompt = 'Fix the bug in parser.js.\nEnsure tests pass.';
  const prep = {
    ok: true,
    job: 'search',
    engine: 'claude',
    brief: '- lib/parser.js:42 handle null token\n- test/parser.test.js:15 add regression test',
  };

  const result = withPrepBrief(basePrompt, prep);
  const expected = [
    'Fix the bug in parser.js.\nEnsure tests pass.',
    '',
    '## brief from the prep pass (search, claude)',
    'Work from this brief. Open other files only if the brief is missing something, and say in your final report what was missing.',
    '',
    '- lib/parser.js:42 handle null token\n- test/parser.test.js:15 add regression test',
  ].join('\n');

  assert.strictEqual(result, expected);
});

test('handles edge cases including prompt idempotency and falsy prompts', () => {
  const prep = {
    ok: true,
    job: 'scout',
    engine: 'haiku',
    brief: 'relevant facts',
  };

  // Idempotency: does not re-add the brief block if already present in prompt
  const alreadyPrepped = [
    'Original task prompt',
    '',
    '## brief from the prep pass (search, claude)',
    'Work from this brief...',
  ].join('\n');
  assert.strictEqual(withPrepBrief(alreadyPrepped, prep), alreadyPrepped);

  // Falsy / empty base prompt converts to string and appends brief
  const emptyResult = withPrepBrief('', prep);
  const expectedEmpty = [
    '',
    '',
    '## brief from the prep pass (scout, haiku)',
    'Work from this brief. Open other files only if the brief is missing something, and say in your final report what was missing.',
    '',
    'relevant facts',
  ].join('\n');
  assert.strictEqual(emptyResult, expectedEmpty);

  const nullPromptResult = withPrepBrief(null, prep);
  assert.strictEqual(nullPromptResult, expectedEmpty);

  const undefinedPromptResult = withPrepBrief(undefined, prep);
  assert.strictEqual(undefinedPromptResult, expectedEmpty);
});

test('returns unmodified prompt when prep is missing, failed, or empty', () => {
  const prompt = 'Implement user profile view';

  // Null or undefined prep
  assert.strictEqual(withPrepBrief(prompt, null), prompt);
  assert.strictEqual(withPrepBrief(prompt, undefined), prompt);

  // Failed prep (ok: false)
  assert.strictEqual(withPrepBrief(prompt, { ok: false, reason: 'timeout', brief: 'partial' }), prompt);
  assert.strictEqual(withPrepBrief(prompt, { ok: false, job: 'search', engine: 'codex' }), prompt);

  // Prep without brief or with empty/falsy brief
  assert.strictEqual(withPrepBrief(prompt, { ok: true, job: 'search', engine: 'codex', brief: '' }), prompt);
  assert.strictEqual(withPrepBrief(prompt, { ok: true, job: 'search', engine: 'codex', brief: null }), prompt);
  assert.strictEqual(withPrepBrief(prompt, { ok: true, job: 'search', engine: 'codex' }), prompt);
});
