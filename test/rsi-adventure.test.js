'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rsi = require('../lib/rsi-record');
const adv = require('../lib/rsi-adventure');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(t) {
  const saved = {
    salt: process.env.ATRIS_RSI_HOLDOUT_SALT_FILE,
    state: process.env.ATRIS_RSI_STATE,
    guard: process.env[rsi.GUARD_ENV],
  };
  const root = tmpdir('atris-rsi-adv-');
  process.env.ATRIS_RSI_HOLDOUT_SALT_FILE = path.join(tmpdir('atris-rsi-salt-'), 'salt');
  delete process.env.ATRIS_RSI_STATE;
  delete process.env[rsi.GUARD_ENV];
  t.after(() => {
    for (const [k, v] of [['ATRIS_RSI_HOLDOUT_SALT_FILE', saved.salt], ['ATRIS_RSI_STATE', saved.state], [rsi.GUARD_ENV, saved.guard]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return root;
}

// A holdout whose fields refuse to be read until this attempt's prediction
// is frozen on disk. Any early read throws and fails the test.
function sealedHoldout(root, payload, since) {
  const reads = [];
  const holdout = {};
  for (const key of Object.keys(payload)) {
    Object.defineProperty(holdout, key, {
      enumerable: true,
      get() {
        const p = adv.predictionPath(root);
        if (!fs.existsSync(p)) throw new Error(`seal broken: holdout.${key} read before prediction froze`);
        const frozen = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Date.parse(frozen.frozen_at) < since) throw new Error(`seal broken: holdout.${key} read against a stale prediction`);
        reads.push(key);
        return payload[key];
      },
    });
  }
  return { holdout, reads };
}

function rowFor(root, node) {
  return rsi.latestNodes(root).find((r) => r.id === node);
}

// Next term of an arithmetic run: the rule the seen data shows.
function nextTerm(seen) {
  const xs = seen.series;
  return { value: xs[xs.length - 1] + (xs[1] - xs[0]), proof: 'constant step from seen' };
}

test('judge refuses by name before anything is frozen', (t) => {
  const root = withEnv(t);
  const { holdout, reads } = sealedHoldout(root, { expect: 1, body: [1] }, 0);
  assert.throws(() => adv.judgeFrozen(root, holdout), (e) => e.name === 'RsiSealError' && e.code === 'ERR_RSI_NOT_FROZEN');
  assert.deepEqual(reads, []);
});

test('wrong prediction against an unknowable holdout ends no and keeps the claim', async (t) => {
  const root = withEnv(t);
  const since = Date.now() - 1000;
  const { holdout } = sealedHoldout(root, { expect: 'secret-7f3a', body: { case: 'unseen' } }, since);
  const r = await adv.runAdventure({
    root,
    claim: 'the next token is guessable',
    nextClaim: 'should never land',
    seen: { tokens: ['a', 'b'] },
    holdout,
    // The attempt tries to grade itself; the judge ignores its proof.
    predict: () => ({ value: 'c', proof: { verdict: 'yes' } }),
  });
  assert.equal(r.verdict, 'no');
  assert.equal(r.claim, 'the next token is guessable');
  assert.equal(adv.readClaim(root), 'the next token is guessable');
  const row = rowFor(root, r.node);
  assert.ok(row, 'finished row exists');
  assert.equal(row.outcome.status, 'failed');
  assert.equal(row.outcome.verify, 'fail');
  assert.equal(row.action.policy_id, rsi.UNSTEERED_POLICY);
});

test('seen rule that holds on the sealed holdout ends yes and advances the claim', async (t) => {
  const root = withEnv(t);
  // A stale prediction from an earlier attempt must not satisfy the seal.
  fs.mkdirSync(path.dirname(adv.predictionPath(root)), { recursive: true });
  fs.writeFileSync(adv.predictionPath(root), JSON.stringify({ value: 10, frozen_at: '2000-01-01T00:00:00.000Z' }));
  const since = Date.now() - 1000;
  const { holdout, reads } = sealedHoldout(root, { expect: 10, body: { series: [2, 4, 6, 8, 10] } }, since);
  const args = [];
  const r = await adv.runAdventure({
    root,
    claim: 'arithmetic runs continue by their step',
    nextClaim: 'geometric runs continue by their ratio',
    seen: { series: [2, 4, 6, 8] },
    holdout,
    predict: (...a) => { args.push(a); return nextTerm(a[0]); },
  });
  assert.equal(r.verdict, 'yes');
  assert.equal(args.length, 1);
  assert.equal(args[0].length, 1, 'predict gets seen only');
  assert.deepEqual(args[0][0], { series: [2, 4, 6, 8] });
  assert.ok(reads.includes('expect'), 'judge read the holdout after freezing');
  assert.equal(r.prediction.value, 10);
  assert.equal(r.prediction.claim, 'arithmetic runs continue by their step');
  assert.ok(Date.parse(r.prediction.frozen_at) >= since);
  assert.equal(r.claim, 'geometric runs continue by their ratio');
  assert.equal(adv.readClaim(root), 'geometric runs continue by their ratio');
  const row = rowFor(root, r.node);
  assert.equal(row.outcome.status, 'shipped');
  assert.equal(row.outcome.verify, 'pass');
  assert.equal(row.action.policy_id, 'p-0000');
});

test('a predictor that reaches for the holdout is stopped by the seal', async (t) => {
  const root = withEnv(t);
  const { holdout } = sealedHoldout(root, { expect: 10, body: [10] }, Date.now() - 1000);
  await assert.rejects(
    adv.runAdventure({ root, claim: 'peeking is impossible', seen: {}, holdout, predict: () => holdout.expect }),
    /seal broken: holdout\.expect read before prediction froze/,
  );
  assert.equal(fs.existsSync(adv.predictionPath(root)), false);
  assert.equal(adv.readClaim(root), 'peeking is impossible');
  const failed = rsi.latestNodes(root).find((r) => r.outcome.status === 'failed');
  assert.ok(failed && /predict failed/.test(failed.outcome.reason));
});

test('missing holdout body ends unclear, records skipped, keeps the claim', async (t) => {
  const root = withEnv(t);
  const { holdout } = sealedHoldout(root, { expect: 10 }, Date.now() - 1000);
  const r = await adv.runAdventure({
    root,
    claim: 'arithmetic runs continue by their step',
    nextClaim: 'should never land',
    seen: { series: [2, 4, 6, 8] },
    holdout,
    predict: nextTerm,
  });
  assert.equal(r.verdict, 'unclear');
  assert.equal(r.claim, 'arithmetic runs continue by their step');
  const row = rowFor(root, r.node);
  assert.equal(row.outcome.status, 'nothing');
  assert.equal(row.outcome.verify, 'skipped');

  const none = await adv.runAdventure({ root, seen: { series: [1, 2] }, holdout: null, predict: nextTerm });
  assert.equal(none.verdict, 'unclear');
  assert.equal(none.claim, 'arithmetic runs continue by their step');
});
