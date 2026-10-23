const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-outcome-text-'));
process.env.HOME = sandboxHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { deriveVerifyPlan, verifyOutcomeText } = require('../lib/wish-audit');

const JOURNAL_RESULT_TEXT = 'the wish is recorded and the result comes back for review';

test.after(() => {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

test('plan objects report their outcome, and the test command reads as the tests passing', () => {
  assert.strictEqual(
    verifyOutcomeText({ command: 'npm run lint', outcome: 'the lint step is clean', status: 'explicit' }),
    'the lint step is clean',
  );
  assert.strictEqual(verifyOutcomeText('node --test'), 'the tests pass');
  assert.strictEqual(verifyOutcomeText('  node --test  '), 'the tests pass');
  assert.strictEqual(verifyOutcomeText(deriveVerifyPlan('add tests for the parser')), 'the tests pass');
});

test('a plain verify command is quoted in the outcome, and quotes inside it are escaped', () => {
  assert.strictEqual(verifyOutcomeText('npm run lint'), 'the verify command "npm run lint" passes');
  assert.strictEqual(verifyOutcomeText('   npm run lint  '), 'the verify command "npm run lint" passes');
  assert.strictEqual(verifyOutcomeText('echo "hi"'), 'the verify command "echo \\"hi\\"" passes');
});

test('empty, missing, or outcome-less input falls back to the journal result text', () => {
  assert.strictEqual(verifyOutcomeText(''), JOURNAL_RESULT_TEXT);
  assert.strictEqual(verifyOutcomeText('   '), JOURNAL_RESULT_TEXT);
  assert.strictEqual(verifyOutcomeText(undefined), JOURNAL_RESULT_TEXT);
  assert.strictEqual(verifyOutcomeText(null), JOURNAL_RESULT_TEXT);
  assert.strictEqual(verifyOutcomeText({}), JOURNAL_RESULT_TEXT);
  assert.strictEqual(verifyOutcomeText({ command: '' }), JOURNAL_RESULT_TEXT);
});
