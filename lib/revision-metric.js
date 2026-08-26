'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'atris.revision_metric.v1';
const DAILY_SCHEMA = 'atris.revision_metric.daily.v1';
const ROLLING_DAYS = 7;
const REVISION_WINDOW_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REVISION_WINDOW_MS = REVISION_WINDOW_HOURS * HOUR_MS;
const ATRIS_TRAILER_RE = /^\s*co-authored-by\s*:.*atris-builder\[bot\]/im;
const IGNORED_FILES = [
  /^atris\/logs\//,
  /^atris\/runs\//,
  /^atris\/team\/[^/]+\/(?:logs|now\.md)/,
  /^atris\/(?:now|thinking|TODO)\.md$/,
  /^atris\/MAP\.md$/,
  /^atris\/brain\//,
  /^atris\/status\//,
  /^test\/fast-tests\.txt$/,
  /^\.atris\//,
];

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `git ${args[0]} exited ${result.status}`).trim();
    const error = new Error(message);
    error.gitFailed = true;
    throw error;
  }
  return String(result.stdout || '');
}

function hasRef(root, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0;
}

function resolveHistoryRef(root, requestedRef) {
  const candidates = requestedRef ? [requestedRef] : ['origin/master', 'master', 'HEAD'];
  const ref = candidates.find((candidate) => hasRef(root, candidate));
  if (!ref) {
    const error = new Error('this folder has no readable git history');
    error.gitFailed = true;
    throw error;
  }
  return ref;
}

function isAtrisAssistedBody(body) {
  return ATRIS_TRAILER_RE.test(String(body || ''));
}

function isRevisionSignalFile(file) {
  const name = String(file || '').trim();
  return Boolean(name) && !IGNORED_FILES.some((pattern) => pattern.test(name));
}

function parseMainlineLog(raw) {
  return String(raw || '')
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [hash, parents, at, authorName, authorEmail, subject, body] = record.split('\x1f');
      return {
        hash: String(hash || '').trim(),
        parents: String(parents || '').trim().split(/\s+/).filter(Boolean),
        at: String(at || '').trim(),
        ms: new Date(at).getTime(),
        authorName: String(authorName || '').trim(),
        authorEmail: String(authorEmail || '').trim(),
        subject: String(subject || '').trim(),
        body: String(body || ''),
      };
    })
    .filter((commit) => commit.hash && Number.isFinite(commit.ms));
}

function readMainlineCommits(root, ref, sinceIso) {
  const raw = git(root, [
    'log', ref, '--first-parent', '--reverse', `--since=${sinceIso}`,
    '--date=iso-strict',
    '--pretty=format:%H%x1f%P%x1f%aI%x1f%aN%x1f%aE%x1f%s%x1f%B%x1e',
  ]);
  return parseMainlineLog(raw);
}

function commitFiles(root, commit) {
  const args = commit.parents.length
    ? ['diff', '--name-only', commit.parents[0], commit.hash]
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit.hash];
  return git(root, args).split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
}

function sideParentIsAtrisAssisted(root, commit, bodyCache) {
  if (commit.parents.length < 2) return false;
  return commit.parents.slice(1).some((parent) => {
    if (!bodyCache.has(parent)) bodyCache.set(parent, git(root, ['show', '-s', '--format=%B', parent]));
    return isAtrisAssistedBody(bodyCache.get(parent));
  });
}

function isHumanAuthor(commit) {
  const identity = `${commit.authorName} ${commit.authorEmail}`;
  return !/\[bot\]|(?:^|[+._-])bot@/i.test(identity);
}

function summarizeChanges(changes, nowMs, excludedLandings) {
  const revisionCount = changes.reduce((sum, change) => sum + change.revision_count, 0);
  const revisedChanges = changes.filter((change) => change.revision_count > 0).length;
  const stillObserving = changes.filter((change) => nowMs - new Date(change.landed_at).getTime() < REVISION_WINDOW_MS).length;
  const matureCleanChanges = changes.filter((change) => (
    change.revision_count === 0
    && nowMs - new Date(change.landed_at).getTime() >= REVISION_WINDOW_MS
  )).length;
  return {
    days: ROLLING_DAYS,
    landed_changes: changes.length,
    revision_count: revisionCount,
    revised_changes: revisedChanges,
    clean_so_far: changes.length - revisedChanges,
    mature_clean_changes: matureCleanChanges,
    still_observing: stillObserving,
    excluded_state_only_landings: excludedLandings,
    target_revision_count: 0,
  };
}

function computeRevisionMetric(root = process.cwd(), options = {}) {
  const now = options.now == null ? new Date() : new Date(options.now);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('now must be a valid date');
  const ref = resolveHistoryRef(root, options.ref);
  const windowStart = new Date(nowMs - ROLLING_DAYS * DAY_MS);
  const commits = readMainlineCommits(root, ref, windowStart.toISOString())
    .filter((commit) => commit.ms <= nowMs);
  const bodyCache = new Map();
  const fileCache = new Map();
  const filesFor = (commit) => {
    if (!fileCache.has(commit.hash)) fileCache.set(commit.hash, commitFiles(root, commit));
    return fileCache.get(commit.hash);
  };
  const changes = [];
  const latestLandingByFile = new Map();
  let excludedLandings = 0;

  for (const commit of commits) {
    const atrisAssisted = isAtrisAssistedBody(commit.body)
      || sideParentIsAtrisAssisted(root, commit, bodyCache);
    const files = filesFor(commit).filter(isRevisionSignalFile);

    if (atrisAssisted) {
      if (!files.length) {
        excludedLandings += 1;
        continue;
      }
      const change = {
        commit: commit.hash,
        subject: commit.subject,
        landed_at: commit.at,
        files: [...new Set(files)].sort(),
        revision_count: 0,
        revisions: [],
      };
      const index = changes.push(change) - 1;
      change.files.forEach((file) => latestLandingByFile.set(file, index));
      continue;
    }

    if (commit.parents.length > 1 || !isHumanAuthor(commit) || !files.length) continue;
    const affected = new Map();
    for (const file of files) {
      const landingIndex = latestLandingByFile.get(file);
      if (landingIndex == null) continue;
      if (!affected.has(landingIndex)) affected.set(landingIndex, []);
      affected.get(landingIndex).push(file);
    }
    for (const [landingIndex, overlap] of affected) {
      const landing = changes[landingIndex];
      const elapsed = commit.ms - new Date(landing.landed_at).getTime();
      if (elapsed <= 0 || elapsed > REVISION_WINDOW_MS) continue;
      landing.revisions.push({
        commit: commit.hash,
        subject: commit.subject,
        at: commit.at,
        files: [...new Set(overlap)].sort(),
      });
      landing.revision_count += 1;
    }
  }

  return {
    schema: SCHEMA,
    generated_at: now.toISOString(),
    source_ref: ref,
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
    signal: {
      kind: 'proxy',
      source: 'git_history',
      landing: 'an atris co-author trailer on a mainline commit or its merged side parent',
      revision: `a later non-merge human commit touching the latest landing's files within ${REVISION_WINDOW_HOURS} hours`,
      limitation: 'the trailer proves assistance, not automatic landing; same-file overlap does not prove why the file changed; human commits carrying the trailer cannot be separated',
      revision_window_hours: REVISION_WINDOW_HOURS,
    },
    changes,
    rolling_7_days: summarizeChanges(changes, nowMs, excludedLandings),
  };
}

function utcDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function dailyRow(metric) {
  const summary = metric.rolling_7_days;
  return {
    schema: DAILY_SCHEMA,
    date: utcDate(metric.generated_at),
    day_basis: 'utc',
    generated_at: metric.generated_at,
    source_ref: metric.source_ref,
    rolling_days: summary.days,
    revision_window_hours: metric.signal.revision_window_hours,
    landed_changes: summary.landed_changes,
    revision_count: summary.revision_count,
    revised_changes: summary.revised_changes,
    clean_so_far: summary.clean_so_far,
    mature_clean_changes: summary.mature_clean_changes,
    still_observing: summary.still_observing,
    excluded_state_only_landings: summary.excluded_state_only_landings,
    measurement_kind: metric.signal.kind,
    signal_source: metric.signal.source,
  };
}

function appendDailySummary(root, metric, options = {}) {
  const file = options.file || path.join(root, '.atris', 'state', 'revision-metric.jsonl');
  const row = dailyRow(metric);
  let existing = [];
  try {
    existing = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sameDay = existing.find((item) => item.schema === DAILY_SCHEMA && item.date === row.date);
  if (sameDay) {
    return { appended: false, row: sameDay, path: path.relative(root, file) };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return { appended: true, row, path: path.relative(root, file) };
}

module.exports = {
  REVISION_WINDOW_HOURS,
  appendDailySummary,
  computeRevisionMetric,
  isRevisionSignalFile,
};
