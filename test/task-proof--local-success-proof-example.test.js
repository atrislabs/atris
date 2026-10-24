'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LOCAL_SUCCESS_PROOF_EXAMPLE,
  taskProofState,
  taskProofLooksMeaningful,
  taskProofExecutionState,
  taskProofLooksExecuted,
  namedUnrunProofCommand,
} = require('../lib/task-proof');

function createTempDir(prefix = 'task-proof-example-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanEnv(tempHome) {
  process.env.HOME = tempHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test('LOCAL_SUCCESS_PROOF_EXAMPLE is a non-empty string with expected guide content', () => {
  const dir = createTempDir('normal-');
  cleanEnv(dir);
  try {
    assert.strictEqual(typeof LOCAL_SUCCESS_PROOF_EXAMPLE, 'string');
    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE.length > 0, true);

    const expected =
      'local success example: atris task ready <id> --verify "<cmd>" --result "<plain sentence>" (exit 0 plus the written atris/runs/ receipt path is enough; do not paste a CI URL unless atris fetched it or you pass --proof-url with --i-fetched)';
    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE, expected);

    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE.startsWith('local success example:'), true);
    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE.includes('atris task ready <id>'), true);
    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE.includes('--verify "<cmd>"'), true);
    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE.includes('--result "<plain sentence>"'), true);
    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE.includes('atris/runs/'), true);
    assert.strictEqual(LOCAL_SUCCESS_PROOF_EXAMPLE.includes('--proof-url with --i-fetched'), true);
  } finally {
    cleanupDir(dir);
  }
});

test('LOCAL_SUCCESS_PROOF_EXAMPLE evaluates as meaningful proof but not executed proof', () => {
  const dir = createTempDir('edge-');
  cleanEnv(dir);
  try {
    // The example includes "atris task", which is a valid command recognized by COMMAND_PROOF_RE
    const state = taskProofState(LOCAL_SUCCESS_PROOF_EXAMPLE);
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.reason, 'proof names a command');
    assert.strictEqual(taskProofLooksMeaningful(LOCAL_SUCCESS_PROOF_EXAMPLE), true);

    // The example text is guidance and has not been executed through buildVerifiedProof
    const execState = taskProofExecutionState(LOCAL_SUCCESS_PROOF_EXAMPLE);
    assert.strictEqual(execState.ok, false);
    assert.strictEqual(execState.reason, 'proof_not_executed');
    assert.strictEqual(taskProofLooksExecuted(LOCAL_SUCCESS_PROOF_EXAMPLE), false);

    // It does not name unrun commands like npm test or git diff --check
    assert.strictEqual(namedUnrunProofCommand(LOCAL_SUCCESS_PROOF_EXAMPLE), '');

    // Edge case 1: substituting template parameters with a plain description yields a valid proof
    const customized = LOCAL_SUCCESS_PROOF_EXAMPLE
      .replace('<id>', 'task-42')
      .replace('<cmd>', 'node --test')
      .replace('<plain sentence>', 'verified parser edge cases');
    const customizedState = taskProofState(customized);
    assert.strictEqual(customizedState.ok, true);
    assert.strictEqual(customizedState.reason, 'proof names a command');

    // Edge case 2: claiming the entire suite passed triggers citation requirements
    const unverifiedSuiteClaim = LOCAL_SUCCESS_PROOF_EXAMPLE
      .replace('<id>', 'task-42')
      .replace('<cmd>', 'node --test')
      .replace('<plain sentence>', 'all tests pass');
    const suiteClaimState = taskProofState(unverifiedSuiteClaim);
    assert.strictEqual(suiteClaimState.ok, false);
    assert.strictEqual(suiteClaimState.code, 'suite_green_citation_required');
  } finally {
    cleanupDir(dir);
  }
});

test('calling LOCAL_SUCCESS_PROOF_EXAMPLE directly throws TypeError since it is a string constant', () => {
  const dir = createTempDir('error-');
  cleanEnv(dir);
  try {
    assert.throws(
      () => {
        LOCAL_SUCCESS_PROOF_EXAMPLE();
      },
      {
        name: 'TypeError',
      }
    );
  } finally {
    cleanupDir(dir);
  }
});
