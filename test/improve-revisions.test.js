'use strict';

// The guarantee gauge: `atris improve revisions` reads git history, calls a
// commit with a known agent Co-authored-by trailer an agent landing, and
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
  isAgentCommitBody,
} = require('../commands/improve');

const BOT_TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

test('agent landings are co-author trailers only, case-insensitive across known agents', () => {
  assert.strictEqual(isAgentCommitBody('fix\n\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>\n'), true);
  assert.strictEqual(isAgentCommitBody('fix\n\nCo-Authored-By: Claude\n'), true);
  assert.strictEqual(isAgentCommitBody('fix\n\nco-authored-by: Cursor Agent <cursoragent@cursor.com>\n'), true);
  assert.strictEqual(isAgentCommitBody('fix\n\nCo-authored-by: Codex <codex@openai.com>\n'), true);
  assert.strictEqual(isAgentCommitBody('fix\n\nCO-AUTHORED-BY: ChatGPT <noreply@openai.com>\n'), true);
  assert.strictEqual(isAgentCommitBody('fix\n\nCo-authored-by: OpenAI <openai@users.noreply.github.com>\n'), true);
  assert.strictEqual(isAgentCommitBody('fix\n\nCo-authored-by: Keshav <keshav@atrislabs.com>\nCo-authored-by: Atris Night Shift <night@atris.ai>\n'), true);
  assert.strictEqual(isAgentCommitBody('fix\n\nCo-authored-by: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>\n'), true);
  assert.strictEqual(isAgentCommitBody('used claude and cursor in the body\natris-builder[bot] mentioned\n'), false);
  assert.strictEqual(isAgentCommitBody('human fix with no trailer\n'), false);
  assert.strictEqual(isAgentCommitBody('fix\n\nCo-authored-by: Jane Doe <jane@example.com>\n'), false);
});

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

test('a later agent commit with a claude trailer is not a human revision', () => {
  const cwd = initRepo();
  const now = Date.now();
  const base = now - 2 * 24 * HOUR;
  try {
    commitFile(cwd, 'a.js', 'v1\n', 'bot lands feature a', { bot: true, atMs: base });
    fs.writeFileSync(path.join(cwd, 'a.js'), 'v2\n', 'utf8');
    fs.writeFileSync(path.join(cwd, '.git', 'COMMIT_MSG_FIXTURE'), 'agent follow-up\n\nCo-Authored-By: Claude\n', 'utf8');
    const date = new Date(base + HOUR).toISOString();
    execSync('git add -A && git commit -q -F .git/COMMIT_MSG_FIXTURE', {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    const summary = collectRevisionSignals(cwd, { days: 14, now });
    assert.strictEqual(summary.landings, 2);
    assert.strictEqual(summary.revised, 0);
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

test('shared journal files never count as revision overlap', () => {
  const cwd = initRepo();
  const now = Date.now();
  const base = now - 2 * 24 * HOUR;
  try {
    fs.mkdirSync(path.join(cwd, 'atris', 'logs', '2026'), { recursive: true });
    // agent lands a journal-only commit; a human writes the same journal later
    commitFile(cwd, 'atris/logs/2026/2026-08-21.md', 'agent receipt\n', 'bot journals a receipt', { bot: true, atMs: base });
    commitFile(cwd, 'atris/logs/2026/2026-08-21.md', 'agent receipt\nhuman note\n', 'human journals too', { atMs: base + HOUR });
    const journalOnly = collectRevisionSignals(cwd, { days: 14, now });
    assert.strictEqual(journalOnly.revised, 0);

    // a landing that touches product code AND the journal is only revised
    // when the human touches the product file
    commitFile(cwd, 'b.js', 'v1\n', 'bot lands feature b', { bot: true, atMs: base + 2 * HOUR });
    commitFile(cwd, 'atris/logs/2026/2026-08-21.md', 'agent receipt\nhuman note\nmore\n', 'human journals again', { atMs: base + 3 * HOUR });
    const mixed = collectRevisionSignals(cwd, { days: 14, now });
    assert.strictEqual(mixed.revised, 0);

    commitFile(cwd, 'b.js', 'v2\n', 'human fixes feature b', { atMs: base + 4 * HOUR });
    const productRevised = collectRevisionSignals(cwd, { days: 14, now });
    assert.strictEqual(productRevised.revised, 1);
  } finally {
    cleanup(cwd);
  }
});

// Boot shows this gauge on every session start. One git process per commit
// cost seconds on a busy repo, so the history is one git log, every plain
// commit's files come back from one batched diff-tree, and a commit's files
// are saved by hash so the next read asks git only for the history.
function countGitCalls(fn) {
  const gitSpawn = require('../lib/git-spawn');
  const original = gitSpawn.runGit;
  const calls = [];
  // Record the subcommand, past any -c settings in front of it.
  const subcommand = (args) => { let i = 0; while (args[i] === '-c') i += 2; return args[i]; };
  gitSpawn.runGit = (args, opts) => { calls.push(subcommand(args)); return original(args, opts); };
  try {
    return { value: fn(), calls };
  } finally {
    gitSpawn.runGit = original;
  }
}

function buildBusyRepo({ atris }) {
  const cwd = initRepo();
  const now = Date.now();
  const base = now - 3 * 24 * HOUR;
  if (atris) {
    fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '.atris/\n');
    fs.mkdirSync(path.join(cwd, '.atris', 'state'), { recursive: true });
  }
  for (let i = 0; i < 6; i++) {
    commitFile(cwd, `f${i}.js`, 'v1\n', `bot lands f${i}`, { bot: true, atMs: base + i * 2 * HOUR });
    commitFile(cwd, `f${i}.js`, 'v2\n', `human fixes f${i}`, { atMs: base + (i * 2 + 1) * HOUR });
  }
  return { cwd, now };
}

function assertBusySummary(summary) {
  assert.strictEqual(summary.landings, 6);
  assert.strictEqual(summary.revised, 6);
  assert.deepStrictEqual(summary.revisions.map((r) => r.files), [['f5.js'], ['f4.js'], ['f3.js'], ['f2.js'], ['f1.js'], ['f0.js']]);
}

test('the gauge reads history in two git calls, not one per commit', () => {
  const { cwd, now } = buildBusyRepo({ atris: false });
  try {
    const run = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assertBusySummary(run.value);
    assert.deepStrictEqual(run.calls, ['log', 'diff-tree']);
    assert.strictEqual(fs.existsSync(path.join(cwd, '.atris')), false, 'no cache file outside a workspace');
  } finally {
    cleanup(cwd);
  }
});

test('a second read reuses saved commit files and only asks git for history', () => {
  const { cwd, now } = buildBusyRepo({ atris: true });
  try {
    const first = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assert.deepStrictEqual(first.calls, ['log', 'diff-tree']);
    const second = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assert.deepStrictEqual(second.calls, ['log']);
    assert.deepStrictEqual(second.value, first.value);
    assertBusySummary(second.value);

    // A new commit is the only one git is asked about.
    commitFile(cwd, 'f0.js', 'v3\n', 'bot lands f0 again', { bot: true, atMs: now - HOUR });
    const third = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assert.deepStrictEqual(third.calls, ['log', 'diff-tree']);
    assert.strictEqual(third.value.landings, 7);
  } finally {
    cleanup(cwd);
  }
});

test('file names read the same fresh and from the cache, whatever core.quotePath says', () => {
  const cwd = initRepo();
  const now = Date.now();
  const base = now - 2 * 24 * HOUR;
  try {
    execSync('git config core.quotePath true', { cwd, stdio: 'pipe' });
    fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '.atris/\n');
    fs.mkdirSync(path.join(cwd, '.atris'), { recursive: true });
    commitFile(cwd, 'caf\u00e9.js', 'v1\n', 'bot lands the cafe page', { bot: true, atMs: base });
    commitFile(cwd, 'caf\u00e9.js', 'v2\n', 'human fixes the cafe page', { atMs: base + HOUR });
    const fresh = collectRevisionSignals(cwd, { days: 14, now });
    assert.deepStrictEqual(fresh.revisions.map((r) => r.files), [['caf\u00e9.js']]);
    execSync('git config core.quotePath false', { cwd, stdio: 'pipe' });
    const cached = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assert.deepStrictEqual(cached.calls, ['log']);
    assert.deepStrictEqual(cached.value, fresh);
  } finally {
    cleanup(cwd);
  }
});

test('saved commit files are dropped when the shallow boundary changes', () => {
  const { cwd, now } = buildBusyRepo({ atris: true });
  try {
    collectRevisionSignals(cwd, { days: 14, now });
    const warm = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assert.deepStrictEqual(warm.calls, ['log']);

    // Cut history at the oldest commit, the way a shallow clone does: that
    // commit now reads as a root. The saved lists must not be trusted.
    const oldest = execSync('git rev-list --max-parents=0 HEAD', { cwd, encoding: 'utf8' }).trim();
    const second = execSync('git rev-list --reverse HEAD', { cwd, encoding: 'utf8' }).split('\n')[1];
    fs.writeFileSync(path.join(cwd, '.git', 'shallow'), `${second}\n`);
    const shallow = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assert.deepStrictEqual(shallow.calls, ['log', 'diff-tree']);

    // Fetching the full history again changes the boundary back.
    fs.rmSync(path.join(cwd, '.git', 'shallow'));
    const unshallow = countGitCalls(() => collectRevisionSignals(cwd, { days: 14, now }));
    assert.deepStrictEqual(unshallow.calls, ['log', 'diff-tree']);
    assert.ok(oldest);
    assertBusySummary(unshallow.value);
  } finally {
    cleanup(cwd);
  }
});
