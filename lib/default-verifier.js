'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MISSION_VERIFIER_TIMEOUT_MS = 120000;

// allowBroadSuite=false is for callers that FREEZE this as a mission's default
// verifier. A broad suite (`npm test`, `node --test`) auto-selected as a silent
// default is a proven footgun: in atrisos-backend `npm test` runs
// backend/scripts/test_fast.sh, which fails without its env and killed missions
// after two ticks (2026-07-16). A default the operator never chose must be a
// check that reflects the mission's own work, not the whole repo's health, so
// the mission lane falls back to the always-safe `git diff --check` and leaves
// broad suites to explicit `--verify`. Fleet/wish keep the suite default.
function resolveDefaultVerifier(root = process.cwd(), { allowBroadSuite = true } = {}) {
  const repoRoot = path.resolve(root);
  if (allowBroadSuite) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.test) return 'npm test';
    } catch {}
    try {
      if (fs.statSync(path.join(repoRoot, 'test')).isDirectory()) return 'node --test';
    } catch {}
  }
  return 'git diff --check';
}

function missionVerifierTimeoutMs(env = process.env) {
  const parsed = Number(env.ATRIS_MISSION_VERIFIER_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed >= 1000) return Math.floor(parsed);
  return DEFAULT_MISSION_VERIFIER_TIMEOUT_MS;
}

function broadSuiteVerifier(command) {
  const compact = String(command || '').trim().replace(/\s+/g, ' ');
  return compact === 'node --test'
    || compact === 'node --test .'
    || compact === 'node --test test'
    || compact === 'node --test tests'
    || compact === 'npm test';
}

function verifierWindowText(timeoutMs) {
  const minutes = timeoutMs / 60000;
  if (minutes === 1) return 'one minute';
  if (minutes === 2) return 'two minutes';
  if (Number.isInteger(minutes)) return `${minutes} minutes`;
  return `${Math.round(timeoutMs / 1000)} seconds`;
}

function verifierBudgetWarning(command, env = process.env) {
  if (!broadSuiteVerifier(command)) return null;
  const timeoutMs = missionVerifierTimeoutMs(env);
  return {
    code: 'verifier_may_outlive_window',
    message: `warning: this wish uses the whole test suite, but mission verification stops after ${verifierWindowText(timeoutMs)}. add a focused check command if that suite runs longer.`,
    verifier: String(command || '').trim(),
    verifier_timeout_ms: timeoutMs,
  };
}

module.exports = {
  missionVerifierTimeoutMs,
  resolveDefaultVerifier,
  verifierBudgetWarning,
};
