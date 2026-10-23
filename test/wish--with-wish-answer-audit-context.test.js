'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { auditWish, withWishAnswerAuditContext } = require('../commands/wish');
const { makeFakeEngines } = require('./helpers/wish-fixture');

const WISH_TEXT = 'make the report better';
const ANSWER = 'raise the score from 60 to 90';
const FIXED_TS = '2026-01-01T00:00:00.000Z';
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wish-answer-audit-'));
}

// The audit consults engine rosters, $HOME config, and ATRIS_* env vars, so
// each scenario runs against a temp HOME with ATRIS_* cleared and a PATH that
// only knows fake engines plus system tools.
function withCleanEnv(overrides, fn) {
  const touched = new Set(Object.keys(overrides));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) touched.add(key);
  }
  const previous = {};
  for (const key of touched) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of touched) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function seedQuestionRow(root, question) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const row = {
    id: 'w-fixed-1',
    n: 7,
    ts: FIXED_TS,
    kind: 'wish',
    status: 'needs_input',
    text: WISH_TEXT,
    questions: [question],
  };
  fs.writeFileSync(path.join(dir, 'wishes.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

function isClarityQuestion(question) {
  return String(question).startsWith('What should be different');
}

test('returns the callback result and invokes it exactly once', () => {
  let calls = 0;
  const out = withWishAnswerAuditContext({ root: '/anywhere', answer: 'yes' }, () => {
    calls += 1;
    return 'sentinel';
  });
  assert.equal(out, 'sentinel');
  assert.equal(calls, 1);
});

test('fills the answer slot and suppresses a repeated question', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = makeFakeEngines(root);

  withCleanEnv({ PATH: `${binDir}:${SYSTEM_PATH}`, HOME: root }, () => {
    const baseline = auditWish(WISH_TEXT, root);
    const clarityQuestion = baseline.questions.find(isClarityQuestion);
    assert.ok(clarityQuestion, 'a vague wish should raise a clarity question');

    seedQuestionRow(root, clarityQuestion);

    // Without an active context the recorded question is asked again.
    const stillAsked = auditWish(WISH_TEXT, root);
    assert.ok(stillAsked.questions.includes(clarityQuestion));

    const context = { root, answer: ANSWER };
    const inside = withWishAnswerAuditContext(context, () => auditWish(`${WISH_TEXT} ${ANSWER}`, root));

    assert.ok(!inside.questions.some(isClarityQuestion));
    assert.deepEqual(context.filled_slot, { kind: 'clarity', question: clarityQuestion, value: ANSWER });
    assert.equal(context.wish_id, 'w-fixed-1');
    assert.equal(context.n, 7);
    assert.equal(context.text, WISH_TEXT);

    // After the callback returns the context is gone, so the question returns.
    const restored = auditWish(WISH_TEXT, root);
    assert.ok(restored.questions.includes(clarityQuestion));
  });
});

test('restores the previous context when the callback throws or nests', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = makeFakeEngines(root);

  withCleanEnv({ PATH: `${binDir}:${SYSTEM_PATH}`, HOME: root }, () => {
    const baseline = auditWish(WISH_TEXT, root);
    const clarityQuestion = baseline.questions.find(isClarityQuestion);
    assert.ok(clarityQuestion);
    seedQuestionRow(root, clarityQuestion);

    const throwing = { root, answer: ANSWER };
    assert.throws(
      () => withWishAnswerAuditContext(throwing, () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(throwing.filled_slot, undefined);
    assert.ok(auditWish(WISH_TEXT, root).questions.includes(clarityQuestion));

    const outer = { root, answer: 'outer answer' };
    const inner = { root, answer: 'inner answer' };
    withWishAnswerAuditContext(outer, () => {
      withWishAnswerAuditContext(inner, () => {
        auditWish(WISH_TEXT, root);
        assert.equal(inner.filled_slot.value, 'inner answer');
      });
      auditWish(WISH_TEXT, root);
      assert.equal(outer.filled_slot.value, 'outer answer');
    });
    assert.ok(auditWish(WISH_TEXT, root).questions.includes(clarityQuestion));
  });
});

test('ignores contexts with a blank answer or a different root', (t) => {
  const root = makeTempDir();
  const other = makeTempDir();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const binDir = makeFakeEngines(root);

  withCleanEnv({ PATH: `${binDir}:${SYSTEM_PATH}`, HOME: root }, () => {
    const baseline = auditWish(WISH_TEXT, root);
    const clarityQuestion = baseline.questions.find(isClarityQuestion);
    assert.ok(clarityQuestion);
    seedQuestionRow(root, clarityQuestion);

    const blank = { root, answer: '   ' };
    const blankResult = withWishAnswerAuditContext(blank, () => auditWish(WISH_TEXT, root));
    assert.ok(blankResult.questions.includes(clarityQuestion));
    assert.equal(blank.filled_slot, undefined);

    const foreign = { root: other, answer: ANSWER };
    const foreignResult = withWishAnswerAuditContext(foreign, () => auditWish(WISH_TEXT, root));
    assert.ok(foreignResult.questions.includes(clarityQuestion));
    assert.equal(foreign.filled_slot, undefined);

    const nullResult = withWishAnswerAuditContext(null, () => auditWish(WISH_TEXT, root));
    assert.ok(nullResult.questions.includes(clarityQuestion));
  });
});
