'use strict';

// One sealed prediction: predict from seen data, freeze it to disk, then
// judge it against a holdout the predictor never received.
// Verdicts are yes, no, or unclear. Only yes may move the claim forward.

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { beginAttempt, finishAttempt, campaignOutcome, IMPROVE_LANE } = require('./rsi-record');

const PREDICTION_SCHEMA = 'atris.prediction.v1';
const VERDICTS = new Set(['yes', 'no', 'unclear']);

class SealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SealError';
    this.code = 'ERR_NOT_FROZEN';
  }
}

function predictionDir(root) {
  return path.join(root, '.atris', 'state', 'rsi');
}

function predictionPath(root) {
  return path.join(predictionDir(root), 'prediction.json');
}

function claimPath(root) {
  return path.join(predictionDir(root), 'claim.txt');
}

function readClaim(root) {
  try {
    return fs.readFileSync(claimPath(root), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeClaim(root, claim) {
  fs.mkdirSync(predictionDir(root), { recursive: true });
  fs.writeFileSync(claimPath(root), `${claim}\n`);
}

function normalizePrediction(out) {
  const raw = out && typeof out === 'object' && !Array.isArray(out) && 'value' in out
    ? { value: out.value, proof: out.proof }
    : { value: out, proof: null };
  if (raw.value === undefined) throw new TypeError('predict returned no value');
  return { value: raw.value, proof: raw.proof === undefined ? null : raw.proof };
}

// Write once, read-only. A stale file from an earlier attempt is removed
// first so the seal can never be satisfied by an old prediction.
function freezePrediction(root, { claim, value, proof, node }) {
  const p = predictionPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const record = { schema: PREDICTION_SCHEMA, claim, value, proof, node: node || null, frozen_at: new Date().toISOString() };
  const fd = fs.openSync(p, 'wx', 0o444);
  try {
    fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function clearPrediction(root) {
  try {
    fs.unlinkSync(predictionPath(root));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
}

// Pure check over the frozen file. Refuses before touching the holdout when
// nothing is frozen, so the holdout can never be read first.
function judgeFrozen(root, holdout) {
  const p = predictionPath(root);
  if (!fs.existsSync(p)) throw new SealError(`no frozen prediction at ${p}; holdout stays sealed`);
  const frozen = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!holdout || typeof holdout !== 'object' || !('expect' in holdout)) return 'unclear';
  if (holdout.body === undefined || holdout.body === null) return 'unclear';
  return isDeepStrictEqual(frozen.value, holdout.expect) ? 'yes' : 'no';
}

// campaignOutcome only knows kept/reverted; unclear is mapped here.
function verdictOutcome(verdict, files) {
  if (!VERDICTS.has(verdict)) throw new TypeError(`unknown verdict: ${verdict}`);
  if (verdict === 'unclear') return { status: 'nothing', verify: 'skipped', reason: 'unclear: holdout missing', files: [] };
  const kept = verdict === 'yes';
  return {
    ...campaignOutcome({ result: kept ? 'kept' : 'reverted', judge: kept, files, reason: `verdict ${verdict}` }),
    files,
  };
}

async function runSealed({ root, claim, seen, holdout, predict, nextClaim, engine = 'claude', lane = IMPROVE_LANE, log = () => {} } = {}) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new TypeError(`root is not a directory: ${root}`);
  if (typeof predict !== 'function') throw new TypeError('predict must be a function');
  const active = claim || readClaim(root);
  if (!active) throw new TypeError('no claim given and no claim.txt on disk');
  if (!readClaim(root)) writeClaim(root, active);

  const attempt = beginAttempt(root, { lane, engine, ground: '', log });
  const node = attempt ? attempt.node : null;
  let prediction;
  try {
    clearPrediction(root);
    // The predictor gets a private copy of seen and nothing else.
    const out = normalizePrediction(await predict(structuredClone(seen)));
    prediction = freezePrediction(root, { claim: active, ...out, node });
  } catch (e) {
    finishAttempt(root, attempt, { status: 'failed', verify: 'skipped', reason: `predict failed: ${e && e.message ? e.message : e}` }, { log });
    throw e;
  }

  const verdict = judgeFrozen(root, holdout);
  const files = [path.relative(root, predictionPath(root))];
  finishAttempt(root, attempt, verdictOutcome(verdict, files), { log });
  if (verdict === 'yes' && nextClaim) writeClaim(root, nextClaim);
  return { verdict, claim: readClaim(root), node, prediction };
}

module.exports = {
  PREDICTION_SCHEMA,
  SealError,
  predictionPath,
  claimPath,
  readClaim,
  judgeFrozen,
  verdictOutcome,
  runSealed,
};
