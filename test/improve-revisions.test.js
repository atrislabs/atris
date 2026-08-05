'use strict';

// The guarantee gauge: `atris improve revisions` reads git history, calls a
// commit with the atris-builder[bot] co-author trailer an agent landing, and
// counts a later human commit touching the same files within 72 hours as a
// revision signal. Target metric: revision rate = 0.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const {
  run,
  collectRevisionSignals,
  formatRevisionsReport,
  collectImproveVitals,
  formatImproveVitals,
} = require('../commands/improve');

const BOT_TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

function initRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-revisions-test-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd, stdio: 'pipe' });
  return cwd;
}

function commitFile(cwd, file, content, subject, { bot = false, atMs } = {}) {
  fs.writeFileSync(path.join(cwd, file), content, 'utf8');
  fs.writeFileSync(path.join(cwd, '.git', 'COMMIT_MSG_FIXTURE'), bot ? `${subject}\n\n${BOT_TRAILER}\n` : `${subject}\n`, 'utf8');
  const date = new Date(atMs).toISOString();
  execSync('git add -A && git commit -q -F .git/COMMIT_MSG_FIXTURE', {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
}

const HOUR = 60 * 60 * 1000;

function buildFixture() {
  const cwd = initRepo();
  const now = Date.now();
  const base = now - 5 * 24 * HOUR;
  // landing one: bot lands a.js, human fixes a.js one hour later -> counted.
  commitFile(cwd, 'a.js', 'v1\n', 'bot lands feature a', { bot: true, atMs: base });
  commitFile(cwd, 'a.js', 'v2\n', 'human fixes feature a', { atMs: base + HOUR });
  // landing two: bot lands b.js, human later touches only c.js -> not counted.
  commitFile(cwd, 'b.js', 'v1\n', 'bot lands feature b', { bot: true, atMs: base + 2 * HOUR });
  commitFile(cwd, 'c.js', 'v1\n', 'human writes unrelated c', { atMs: base + 3 * HOUR });
  // landing three: bot lands d.js, human touches d.js 100 hours later -> outside window.
  commitFile(cwd, 'd.js', 'v1\n', 'bot lands feature d', { bot: true, atMs: base + 4 * HOUR });
  commitFile(cwd, 'd.js', 'v2\n', 'human reworks d much later', { atMs: base + 104 * HOUR });
  return { cwd, now };
}

test('counts same-file human follow-ups within 72h and nothing else', () => {
  const { cwd, now } = buildFixture();
  try {
    const summary = collectRevisionSignals(cwd, { days: 14, now });
    assert.strictEqual(summary.landings, 3);
    assert.strictEqual(summary.revised, 1);
    assert.ok(Math.abs(summary.rate - 1 / 3) < 1e-9);
    assert.strictEqual(summary.revisions.length, 1);
    assert.strictEqual(summary.revisions[0].landing.subject, 'bot lands feature a');
    assert.deepStrictEqual(summary.revisions[0].files, ['a.js']);
    assert.strictEqual(summary.revisions[0].revised_by.length, 1);
    assert.strictEqual(summary.revisions[0].revised_by[0].subject, 'human fixes feature a');
  } finally {
    cleanup(cwd);
  }
});

test('plain report has no hashes, no em dashes, stays lowercase', () => {
  const { cwd, now } = buildFixture();
  try {
    const text = formatRevisionsReport(collectRevisionSignals(cwd, { days: 14, now }));
    assert.match(text, /agent landings in the last 14 days: 3\./);
    assert.match(text, /landings a human then revised: 1\./);
    assert.match(text, /revision rate: 33 percent/);
    assert.match(text, /a human then changed a\.js within 72 hours\./);
    assert.ok(!text.includes('—'), 'no em dashes in the report');
    assert.ok(!/\b[0-9a-f]{7,40}\b/.test(text), 'no commit hashes in the text body');
    assert.strictEqual(text, text.toLowerCase(), 'report is lowercase');
  } finally {
    cleanup(cwd);
  }
});

test('--json emits the schema with hashes for machines', async () => {
  const { cwd } = buildFixture();
  const origCwd = process.cwd();
  const origLog = console.log;
  const lines = [];
  try {
    process.chdir(cwd);
    console.log = (...args) => lines.push(args.join(' '));
    const code = await run(['revisions', '--days', '14', '--json']);
    console.log = origLog;
    assert.strictEqual(code, 0);
    const payload = JSON.parse(lines.join('\n'));
    assert.strictEqual(payload.schema, 'atris.improve_revisions.v1');
    assert.strictEqual(payload.days, 14);
    assert.strictEqual(payload.window_hours, 72);
    assert.strictEqual(payload.landings, 3);
    assert.strictEqual(payload.revised, 1);
    assert.match(payload.revisions[0].landing.hash, /^[0-9a-f]{40}$/);
    assert.match(payload.revisions[0].revised_by[0].hash, /^[0-9a-f]{40}$/);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    cleanup(cwd);
  }
});

test('a repo with no commits reports plainly that there is nothing to measure', () => {
  const cwd = initRepo();
  try {
    const summary = collectRevisionSignals(cwd, { days: 14 });
    assert.strictEqual(summary.landings, 0);
    assert.strictEqual(summary.revised, 0);
    assert.strictEqual(summary.rate, 0);
    const text = formatRevisionsReport(summary);
    assert.match(text, /no agent landings found in the last 14 days\. nothing to measure yet\./);
  } finally {
    cleanup(cwd);
  }
});

test('merge commits are attributed by their first-parent diff', () => {
  const cwd = initRepo();
  const now = Date.now();
  const base = now - 3 * 24 * HOUR;
  try {
    commitFile(cwd, 'seed.js', 'v1\n', 'seed', { atMs: base - HOUR });
    execSync('git checkout -q -b side', { cwd, stdio: 'pipe' });
    commitFile(cwd, 'm.js', 'v1\n', 'bot builds m on a branch', { bot: true, atMs: base });
    execSync('git checkout -q -', { cwd, stdio: 'pipe' });
    const mergeDate = new Date(base + HOUR).toISOString();
    fs.writeFileSync(path.join(cwd, '.git', 'COMMIT_MSG_FIXTURE'), `merge bot work\n\n${BOT_TRAILER}\n`, 'utf8');
    execSync('git merge -q --no-ff side -F .git/COMMIT_MSG_FIXTURE', {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: mergeDate, GIT_COMMITTER_DATE: mergeDate },
    });
    commitFile(cwd, 'm.js', 'v2\n', 'human fixes merged m', { atMs: base + 2 * HOUR });
    const summary = collectRevisionSignals(cwd, { days: 14, now });
    // both the branch commit and the merge carry the trailer; the merge's
    // first-parent diff includes m.js, so the human fix revises the landing.
    assert.ok(summary.revised >= 1, 'the merged landing counts as revised');
    const files = summary.revisions.flatMap((r) => r.files);
    assert.ok(files.includes('m.js'));
  } finally {
    cleanup(cwd);
  }
});

test('improve vitals show the guarantee gauge from git history, counts as words', () => {
  const { cwd, now } = buildFixture();
  try {
    const vitals = collectImproveVitals({ workspace: cwd, now }, { cronInstalled: () => true });
    assert.strictEqual(vitals.guarantee.landings, 3);
    assert.strictEqual(vitals.guarantee.revised, 1);
    assert.strictEqual(vitals.guarantee.sentence, 'three landings this fortnight, one needed a human fix.');
    const output = formatImproveVitals(vitals);
    assert.match(output, /three landings this fortnight, one needed a human fix\./);
    assert.strictEqual(output, output.toLowerCase());
    assert.ok(!output.includes('—'), 'no em dashes in the vitals');
  } finally {
    cleanup(cwd);
  }
});

test('improve vitals say zero needed a human fix when landings went clean', () => {
  const cwd = initRepo();
  const now = Date.now();
  const base = now - 2 * 24 * HOUR;
  try {
    commitFile(cwd, 'a.js', 'v1\n', 'bot lands feature a', { bot: true, atMs: base });
    commitFile(cwd, 'b.js', 'v1\n', 'bot lands feature b', { bot: true, atMs: base + HOUR });
    const vitals = collectImproveVitals({ workspace: cwd, now }, { cronInstalled: () => true });
    assert.strictEqual(vitals.guarantee.sentence, 'two landings this fortnight, zero needed a human fix.');
  } finally {
    cleanup(cwd);
  }
});

test('improve vitals omit the guarantee gauge when there is no git history', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-improve-revisions-test-'));
  try {
    const vitals = collectImproveVitals({ workspace: cwd }, { cronInstalled: () => true });
    assert.strictEqual(vitals.guarantee, null);
    assert.ok(!formatImproveVitals(vitals).includes('fortnight'));
  } finally {
    cleanup(cwd);
  }
});
