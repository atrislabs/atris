'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MISSION_VERIFIER_TIMEOUT_MS = 120000;

function resolveDefaultVerifier(root = process.cwd()) {
  const repoRoot = path.resolve(root);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.test) return 'npm test';
  } catch {}
  try {
    if (fs.statSync(path.join(repoRoot, 'test')).isDirectory()) return 'node --test';
  } catch {}
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
  DEFAULT_MISSION_VERIFIER_TIMEOUT_MS,
  broadSuiteVerifier,
  missionVerifierTimeoutMs,
  resolveDefaultVerifier,
  verifierBudgetWarning,
};
