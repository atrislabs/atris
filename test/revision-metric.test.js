'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  computeRevisionMetric,
} = require('../lib/revision-metric');
const { revisionsCommand } = require('../commands/revisions');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

const TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-revision-metric-'));
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
  return runGit(root, ['rev-parse', 'HEAD']);
}

function remove(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('a landed merge followed by a human correction counts one revision', () => {
  const root = fixtureRepo();
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  try {
    commit(root, 'README.md', 'seed\n', 'seed', now - 3 * DAY_MS);
    runGit(root, ['checkout', '-q', '-b', 'agent-change']);
    commit(root, 'lib/feature.js', 'first\n', 'agent builds feature', now - 2 * DAY_MS, true);
    runGit(root, ['checkout', '-q', 'master']);
    const mergeAt = new Date(now - 2 * DAY_MS + HOUR_MS).toISOString();
    runGit(root, ['merge', '-q', '--no-ff', 'agent-change', '-m', 'merge assisted feature'], {
      env: { GIT_AUTHOR_DATE: mergeAt, GIT_COMMITTER_DATE: mergeAt },
    });
    commit(root, 'lib/feature.js', 'corrected\n', 'human corrects feature', now - 2 * DAY_MS + 2 * HOUR_MS);

    const metric = computeRevisionMetric(root, { ref: 'master', now });
    assert.equal(metric.changes.length, 1);
    assert.equal(metric.changes[0].revision_count, 1);
    assert.equal(metric.changes[0].revisions[0].subject, 'human corrects feature');
    assert.deepEqual(metric.changes[0].revisions[0].files, ['lib/feature.js']);
  } finally {
    remove(root);
  }
});

test('a clean landed change counts zero revisions', () => {
  const root = fixtureRepo();
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  try {
    commit(root, 'src/clean.js', 'clean\n', 'agent lands clean feature', now - 4 * DAY_MS, true);
    commit(root, 'src/unrelated.js', 'human work\n', 'human changes another file', now - 3 * DAY_MS);

    const metric = computeRevisionMetric(root, { ref: 'master', now });
    assert.equal(metric.changes.length, 1);
    assert.equal(metric.changes[0].revision_count, 0);
    assert.equal(metric.rolling_7_days.revision_count, 0);
    assert.equal(metric.rolling_7_days.mature_clean_changes, 1);
  } finally {
    remove(root);
  }
});

test('the rolling seven-day summary adds landing and revision counts', () => {
  const root = fixtureRepo();
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  try {
    commit(root, 'src/old.js', 'old landing\n', 'old assisted landing', now - 9 * DAY_MS, true);
    commit(root, 'src/old.js', 'old correction\n', 'old human correction', now - 9 * DAY_MS + HOUR_MS);
    commit(root, 'src/a.js', 'landing a\n', 'assisted landing a', now - 6 * DAY_MS, true);
    commit(root, 'src/a.js', 'correction a\n', 'human correction a', now - 6 * DAY_MS + HOUR_MS);
    commit(root, 'src/b.js', 'landing b\n', 'assisted landing b', now - 5 * DAY_MS, true);
    commit(root, 'src/c.js', 'landing c\n', 'assisted landing c', now - 2 * DAY_MS, true);
    commit(root, 'src/c.js', 'correction c1\n', 'human correction c one', now - 2 * DAY_MS + HOUR_MS);
    commit(root, 'src/c.js', 'correction c2\n', 'human correction c two', now - 2 * DAY_MS + 2 * HOUR_MS);

    const summary = computeRevisionMetric(root, { ref: 'master', now }).rolling_7_days;
    assert.deepEqual(summary, {
      days: 7,
      landed_changes: 3,
      revision_count: 3,
      revised_changes: 2,
      clean_so_far: 1,
      mature_clean_changes: 1,
      still_observing: 1,
      excluded_state_only_landings: 0,
      target_revision_count: 0,
    });
  } finally {
    remove(root);
  }
});

test('repeated same-day command runs keep one daily summary row', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-revision-row-'));
  const metric = {
    generated_at: '2026-08-26T12:00:00.000Z',
    source_ref: 'master',
    signal: { revision_window_hours: 72, source: 'git_history' },
    rolling_7_days: {
      days: 7,
      landed_changes: 2,
      revision_count: 1,
      revised_changes: 1,
      clean_so_far: 1,
      mature_clean_changes: 0,
      still_observing: 2,
    },
  };
  const originalLog = console.log;
  try {
    console.log = () => {};
    const first = revisionsCommand([], { root, computeRevisionMetric: () => metric });
    const second = revisionsCommand([], { root, computeRevisionMetric: () => metric });
    const file = path.join(root, '.atris', 'state', 'revision-metric.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(first, 0);
    assert.equal(second, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].revision_count, 1);
  } finally {
    console.log = originalLog;
    remove(root);
  }
});

test('atris revisions help is routed and stays plain lowercase', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-revision-help-'));
  try {
    const result = spawnSync(process.execPath, [cliPath, 'revisions', '--help'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage: atris revisions \[--json\]/);
    assert.equal(result.stdout, result.stdout.toLowerCase());
    assert.doesNotMatch(result.stdout, /—/);
    assert.equal(fs.existsSync(path.join(root, '.atris')), false);
  } finally {
    remove(root);
  }
});
