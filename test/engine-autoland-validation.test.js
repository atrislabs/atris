'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  engineAnswerValidationLine,
  runEngineAnswerValidation,
} = require('../commands/autoland');
const {
  MAX_AUTOMATIC_VALIDATIONS_PER_TICK,
  VALIDATION_SCHEMA,
  validateRecentAskReceipts,
} = require('../lib/engine-validate');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-autoland-validation-'));
}

function answered(engine = 'codex', overrides = {}) {
  return {
    engine,
    model: `${engine}-test`,
    prompt: `question for ${engine}`,
    label: `${engine}-answer`,
    status: 'answered',
    ok: true,
    stdout: `answer from ${engine}`,
    stderr: '',
    duration_ms: 1,
    ...overrides,
  };
}

function writeAskReceipt(root, name, { at, status = 'completed', answers = [answered()] } = {}) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const receiptPath = path.join(runsDir, `engine-ask-${name}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    schema: 'atris.engine_ask_receipt.v1',
    at: at || '2026-08-12T20:00:00.000Z',
    status,
    answers,
  }, null, 2)}\n`);
  return receiptPath;
}

function validationRows(root) {
  const filePath = path.join(root, 'atris', 'benchmarks', 'validations.jsonl');
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakePassingReferee(calls = []) {
  return async (job) => {
    calls.push(job);
    return {
      ok: true,
      stdout: 'VERDICT: pass\nREASON: the answer addresses the prompt.',
      stderr: '',
      duration_ms: 2,
    };
  };
}

test('hourly tick grades an unchecked completed ask receipt', async () => {
  const root = tempRoot();
  const calls = [];
  try {
    writeAskReceipt(root, 'unchecked');
    const receipt = {};
    await runEngineAnswerValidation(root, receipt, {
      executeAskJob: fakePassingReferee(calls),
      now: () => new Date('2026-08-12T21:00:00.000Z'),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].engine, 'haiku');
    assert.equal(receipt.engine_answer_validation.graded_receipts, 1);
    assert.equal(receipt.engine_answer_validation.graded_answers, 1);
    assert.equal(validationRows(root).length, 1);
    assert.equal(engineAnswerValidationLine(receipt), 'graded 1 engine answer, scoreboard updated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hourly validation skips a receipt already covered by the verdict ledger', async () => {
  const root = tempRoot();
  let calls = 0;
  try {
    writeAskReceipt(root, 'covered');
    const benchmarksDir = path.join(root, 'atris', 'benchmarks');
    fs.mkdirSync(benchmarksDir, { recursive: true });
    fs.writeFileSync(path.join(benchmarksDir, 'validations.jsonl'), `${JSON.stringify({
      schema: VALIDATION_SCHEMA,
      source_receipt: 'atris/runs/engine-ask-covered.json',
      worker_engine: 'codex',
      verdict: 'pass',
    })}\n`);

    const summary = await validateRecentAskReceipts(root, {
      executeAskJob: async () => { calls += 1; },
    });

    assert.equal(calls, 0);
    assert.equal(summary.skipped_covered, 1);
    assert.equal(summary.graded_answers, 0);
    assert.equal(engineAnswerValidationLine({ engine_answer_validation: summary }), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hourly validation skips running and failed ask receipts', async () => {
  const root = tempRoot();
  let calls = 0;
  try {
    writeAskReceipt(root, 'running', { status: 'running' });
    writeAskReceipt(root, 'failed', { status: 'failed' });

    const summary = await validateRecentAskReceipts(root, {
      executeAskJob: async () => { calls += 1; },
    });

    assert.equal(calls, 0);
    assert.equal(summary.skipped_status, 2);
    assert.equal(summary.graded_answers, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hourly validation grades only the three newest candidates', async () => {
  const root = tempRoot();
  const calls = [];
  try {
    for (let index = 1; index <= 5; index += 1) {
      writeAskReceipt(root, `candidate-${index}`, {
        at: `2026-08-12T2${index}:00:00.000Z`,
        answers: [answered('codex', { label: `answer-${index}` })],
      });
    }

    const summary = await validateRecentAskReceipts(root, {
      executeAskJob: fakePassingReferee(calls),
    });

    assert.equal(MAX_AUTOMATIC_VALIDATIONS_PER_TICK, 3);
    assert.equal(summary.attempted_receipts, 3);
    assert.equal(summary.graded_receipts, 3);
    assert.equal(calls.length, 3);
    assert.deepEqual(validationRows(root).map((row) => row.source_receipt), [
      'atris/runs/engine-ask-candidate-5.json',
      'atris/runs/engine-ask-candidate-4.json',
      'atris/runs/engine-ask-candidate-3.json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hourly validation skips haiku worker answers instead of self-grading', async () => {
  const root = tempRoot();
  const calls = [];
  try {
    writeAskReceipt(root, 'haiku-only', {
      at: '2026-08-12T22:00:00.000Z',
      answers: [answered('haiku')],
    });
    writeAskReceipt(root, 'mixed', {
      at: '2026-08-12T21:00:00.000Z',
      answers: [answered('haiku'), answered('cursor')],
    });

    const summary = await validateRecentAskReceipts(root, {
      executeAskJob: fakePassingReferee(calls),
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /answer from cursor/);
    assert.doesNotMatch(calls[0].prompt, /answer from haiku/);
    assert.equal(summary.skipped_self_grade, 2);
    assert.equal(summary.graded_answers, 1);
    assert.equal(summary.notes.length, 2);
    assert.match(summary.notes[0], /judge never equals worker/);
    assert.deepEqual(validationRows(root).map((row) => row.worker_engine), ['cursor']);

    const verdictReceipt = fs.readdirSync(path.join(root, 'atris', 'runs'))
      .find((name) => name.startsWith('validate-'));
    const verdict = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'runs', verdictReceipt), 'utf8'));
    assert.deepEqual(verdict.skipped, [{
      answer_label: 'haiku-answer',
      worker_engine: 'haiku',
      reason: 'judge never equals worker',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hourly tick records unsure and survives a referee failure', async () => {
  const root = tempRoot();
  try {
    writeAskReceipt(root, 'referee-failure');
    const receipt = {};

    await runEngineAnswerValidation(root, receipt, {
      executeAskJob: async () => { throw new Error('fake referee unavailable'); },
    });

    assert.equal(receipt.engine_answer_validation.graded_answers, 1);
    assert.equal(receipt.engine_answer_validation.failures, 0);
    assert.equal(receipt.engine_answer_validation_error, undefined);
    assert.equal(validationRows(root)[0].verdict, 'unsure');
    assert.equal(validationRows(root)[0].reason, 'referee did not complete successfully.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
