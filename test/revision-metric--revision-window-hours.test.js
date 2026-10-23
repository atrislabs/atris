'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  REVISION_WINDOW_HOURS,
  computeRevisionMetric,
} = require('../lib/revision-metric');

const TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function runGit(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-revision-window-'));
  runGit(root, ['init', '-q', '--initial-branch=master']);
  runGit(root, ['config', 'user.name', 'fixture human']);
  runGit(root, ['config', 'user.email', 'human@example.com']);
  return root;
}

function commit(root, file, content, subject, atMs, assisted = false) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  runGit(root, ['add', '--', file]);
  const date = new Date(atMs).toISOString();
  runGit(root, ['commit', '-q', '-m', assisted ? `${subject}\n\n${TRAILER}` : subject], {
    env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function remove(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('REVISION_WINDOW_HOURS is a positive whole number of hours inside the rolling window', () => {
  assert.equal(typeof REVISION_WINDOW_HOURS, 'number');
  assert.ok(Number.isInteger(REVISION_WINDOW_HOURS));
  assert.ok(REVISION_WINDOW_HOURS > 0);
  assert.equal(REVISION_WINDOW_HOURS, 72);
  assert.ok(REVISION_WINDOW_HOURS < 7 * 24);
});

test('a human commit inside the window counts as a revision of the landing', () => {
  const root = fixtureRepo();
  try {
    const landedAt = NOW - 4 * DAY_MS;
    commit(root, 'src/feature.js', 'v1\n', 'assisted landing', landedAt, true);
    commit(root, 'src/feature.js', 'v2\n', 'human fix', landedAt + HOUR_MS);

    const metric = computeRevisionMetric(root, { ref: 'master', now: NOW });
    assert.equal(metric.signal.revision_window_hours, REVISION_WINDOW_HOURS);
    assert.equal(metric.changes.length, 1);
    assert.equal(metric.changes[0].revision_count, 1);
    assert.equal(metric.changes[0].revisions[0].subject, 'human fix');
  } finally {
    remove(root);
  }
});

test('a commit exactly at the window edge counts but one second past it does not', () => {
  const root = fixtureRepo();
  try {
    const landedAt = NOW - 4 * DAY_MS;
    const windowMs = REVISION_WINDOW_HOURS * HOUR_MS;
    commit(root, 'src/feature.js', 'v1\n', 'assisted landing', landedAt, true);
    commit(root, 'src/feature.js', 'v2\n', 'fix at the edge', landedAt + windowMs);
    commit(root, 'src/feature.js', 'v3\n', 'fix past the edge', landedAt + windowMs + 1000);

    const metric = computeRevisionMetric(root, { ref: 'master', now: NOW });
    assert.equal(metric.changes.length, 1);
    assert.equal(metric.changes[0].revision_count, 1);
    assert.equal(metric.changes[0].revisions[0].subject, 'fix at the edge');
  } finally {
    remove(root);
  }
});

test('a repo with no commits throws instead of reporting a metric', () => {
  const root = fixtureRepo();
  try {
    assert.throws(
      () => computeRevisionMetric(root, { ref: 'master', now: NOW }),
      (error) => error.gitFailed === true && /no readable git history/.test(error.message),
    );
  } finally {
    remove(root);
  }
});
