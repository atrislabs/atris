'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RECEIPT_REL = path.join('.atris', 'state', 'caretaker.scan.latest.json');
const PR_JSON_FIELDS = [
  'number',
  'title',
  'headRefOid',
  'statusCheckRollup',
  'reviews',
  'latestReviews',
  'commits',
  'reviewDecision',
].join(',');

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED']);
const FAIL_STATES = new Set(['FAILURE', 'ERROR']);
const PASS_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const PASS_STATES = new Set(['SUCCESS']);
const PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'REQUESTED', 'WAITING', 'EXPECTED']);

function runGh(args, { cwd, env } = {}) {
  return spawnSync('gh', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    env: env || process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function printGhUnavailable() {
  console.error('gh is missing or not signed in. install github cli and run gh auth login.');
}

function ensureGh(options = {}) {
  const version = runGh(['--version'], options);
  if ((version.error && version.error.code === 'ENOENT') || version.error || version.status !== 0) {
    return false;
  }
  const auth = runGh(['auth', 'status'], options);
  if ((auth.error && auth.error.code === 'ENOENT') || auth.error || auth.status !== 0) {
    return false;
  }
  return true;
}

function checkName(check) {
  if (!check || typeof check !== 'object') return '';
  return String(check.name || check.context || '').trim();
}

function checkTime(check) {
  const raw = check?.completedAt || check?.startedAt || check?.submittedAt || '';
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function isFailingCheck(check) {
  const conclusion = String(check?.conclusion || '').toUpperCase();
  const state = String(check?.state || '').toUpperCase();
  const status = String(check?.status || '').toUpperCase();
  if (FAIL_CONCLUSIONS.has(conclusion) || FAIL_STATES.has(state)) return true;
  if (status === 'COMPLETED' && conclusion && !PASS_CONCLUSIONS.has(conclusion)) return true;
  return false;
}

function isPassingCheck(check) {
  const conclusion = String(check?.conclusion || '').toUpperCase();
  const state = String(check?.state || '').toUpperCase();
  if (PASS_CONCLUSIONS.has(conclusion) || PASS_STATES.has(state)) return true;
  return false;
}

function isPendingCheck(check) {
  const status = String(check?.status || '').toUpperCase();
  const state = String(check?.state || '').toUpperCase();
  if (PENDING_STATUSES.has(status) || PENDING_STATUSES.has(state)) return true;
  if (!check?.conclusion && !PASS_STATES.has(state) && !FAIL_STATES.has(state)) {
    return status !== 'COMPLETED';
  }
  return false;
}

function latestChecks(rollup = []) {
  const byName = new Map();
  for (const check of Array.isArray(rollup) ? rollup : []) {
    const name = checkName(check);
    if (!name) continue;
    const prev = byName.get(name);
    if (!prev || checkTime(check) >= checkTime(prev)) byName.set(name, check);
  }
  return [...byName.values()];
}

function lastPushAt(pr) {
  const commits = Array.isArray(pr?.commits) ? pr.commits : [];
  let latest = 0;
  let latestIso = '';
  for (const commit of commits) {
    const iso = commit?.committedDate || commit?.authoredDate || '';
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms >= latest) {
      latest = ms;
      latestIso = iso;
    }
  }
  return latestIso;
}

function collectReviews(pr) {
  const out = [];
  for (const list of [pr?.reviews, pr?.latestReviews]) {
    if (!Array.isArray(list)) continue;
    for (const review of list) out.push(review);
  }
  return out;
}

function activeChangesRequested(pr) {
  const pushAt = lastPushAt(pr);
  const pushMs = Date.parse(pushAt);
  const reviews = collectReviews(pr).filter((review) => {
    if (String(review?.state || '').toUpperCase() !== 'CHANGES_REQUESTED') return false;
    const submittedMs = Date.parse(review?.submittedAt || '');
    if (!Number.isFinite(submittedMs)) return false;
    if (!Number.isFinite(pushMs)) return true;
    return submittedMs > pushMs;
  });
  return reviews;
}

function classifyPullRequest(pr) {
  const checks = latestChecks(pr?.statusCheckRollup);
  const failing = checks.filter(isFailingCheck);
  if (failing.length) {
    const name = checkName(failing[0]) || 'ci';
    return {
      state: 'ci-red',
      reason: `the latest ${name} check failed`,
    };
  }

  if (activeChangesRequested(pr).length) {
    return {
      state: 'changes-requested',
      reason: 'a review asked for changes after the last push',
    };
  }

  if (!checks.length) {
    return {
      state: 'waiting',
      reason: 'no checks have reported yet',
    };
  }

  if (checks.some(isPendingCheck)) {
    return {
      state: 'waiting',
      reason: 'checks are still running',
    };
  }

  if (checks.every(isPassingCheck)) {
    return {
      state: 'green-mergeable',
      reason: 'checks passed and nothing blocks merge',
    };
  }

  return {
    state: 'waiting',
    reason: 'checks or reviews are not ready to judge',
  };
}

function formatSentence(entry) {
  const title = String(entry.title || 'untitled').trim() || 'untitled';
  return `pr ${entry.number} "${title}" is ${entry.state} because ${entry.reason}.`.toLowerCase();
}

function writeReceipt(root, receipt) {
  const file = path.join(root, RECEIPT_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return file;
}

function listOpenPullRequests(options = {}) {
  const result = runGh([
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    PR_JSON_FIELDS,
  ], options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'gh pr list failed').trim();
    throw new Error(detail.split(/\r?\n/).find(Boolean) || 'gh pr list failed');
  }
  const raw = String(result.stdout || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function scanPullRequests({ cwd, env, now } = {}) {
  const root = path.resolve(cwd || process.cwd());
  const scannedAt = (now instanceof Date ? now : new Date()).toISOString();
  const prs = listOpenPullRequests({ cwd: root, env }).map((pr) => {
    const classified = classifyPullRequest(pr);
    return {
      number: Number(pr.number),
      title: String(pr.title || ''),
      state: classified.state,
      reason: classified.reason,
      head_sha: String(pr.headRefOid || ''),
      scanned_at: scannedAt,
    };
  });
  const receipt = { scanned_at: scannedAt, prs };
  const receiptPath = writeReceipt(root, receipt);
  return { root, receipt, receiptPath, prs };
}

function showCaretakerHelp() {
  console.log('usage: atris caretaker scan');
  console.log('classify open pull requests on origin. detection only; no fix, comment, or merge.');
}

function caretakerCommand(args = [], options = {}) {
  const argv = Array.isArray(args) ? args.filter((arg) => arg !== '--') : [];
  if (!argv.length || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    showCaretakerHelp();
    return 0;
  }
  if (argv[0] !== 'scan') {
    console.error(`unknown caretaker command: ${argv[0]}`);
    showCaretakerHelp();
    return 1;
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  if (!ensureGh({ cwd, env })) {
    printGhUnavailable();
    return 1;
  }

  try {
    const { prs } = scanPullRequests({ cwd, env, now: options.now });
    if (!prs.length) {
      console.log('no open pull requests.');
      return 0;
    }
    for (const entry of prs) console.log(formatSentence(entry));
    return 0;
  } catch (error) {
    console.error(`caretaker scan failed: ${error.message || error}`);
    return 1;
  }
}

module.exports = { caretakerCommand };
