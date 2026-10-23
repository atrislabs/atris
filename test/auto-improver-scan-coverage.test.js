const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(cwd, '.atris', 'tasks.db') };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
}

function dateDaysAgo(days) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

// A real workspace has hundreds of member files (skills, missions, months of
// old logs). The scanner used to stop walking after 220 files, so this week's
// member logs were silently skipped and repeat problems counted as zero.
test('auto-improver scan reads recent member logs even when old team files pile up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-coverage-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], dir).status, 0);

    const busyLogs = path.join(dir, 'atris', 'team', 'zz-archivist', 'logs');
    fs.mkdirSync(busyLogs, { recursive: true });
    for (let i = 0; i < 300; i += 1) {
      fs.writeFileSync(path.join(busyLogs, `2025-01-${String(i).padStart(3, '0')}-old.md`), '# old\n', 'utf8');
    }

    const recentLogs = path.join(dir, 'atris', 'team', 'builder', 'logs');
    fs.mkdirSync(recentLogs, { recursive: true });
    fs.writeFileSync(path.join(recentLogs, `${dateDaysAgo(1)}.md`), [
      '# builder log',
      '- ERROR worktree push rejected by stale lock',
      '- ERROR worktree push rejected by stale lock',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], dir);
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const signals = JSON.parse(wake.stdout).auto_improver.scan.log_signals;
    const hit = signals.repeated_failures.find((failure) => /stale lock/.test(failure.pattern));
    assert.ok(hit, `recent member log was not scanned: ${JSON.stringify(signals)}`);
    assert.equal(hit.count, 2);
    assert.equal(hit.evidence[0].path, `atris/team/builder/logs/${dateDaysAgo(1)}.md`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Goal lines and empty error fields are not failures. On 2026-10-14 they were
// 3 of the 8 repeat problems (a mission naming "leftover error text", a board
// mission listing "failed" as a state, and driver logs printing "error": null),
// which pinned the pain score at its ceiling so it could never trend down.
test('auto-improver scan skips mission goal lines and empty error fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-noise-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], dir).status, 0);

    const logs = path.join(dir, 'atris', 'team', 'builder', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, `${dateDaysAgo(1)}.md`), [
      '# builder log',
      '- mission: The team briefing tells the truth: no empty commit ids or leftover error text',
      '- mission: The team briefing tells the truth: no empty commit ids or leftover error text',
      '  "error": null,',
      '  "error": null,',
      '- note: Released by builder: the work ran but its check failed: npm run test:fast',
      '- note: Released by builder: the work ran but its check failed: npm run test:fast',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], dir);
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const patterns = JSON.parse(wake.stdout).auto_improver.scan.log_signals.repeated_failures.map((failure) => failure.pattern);
    assert.ok(patterns.some((pattern) => /check failed/.test(pattern)), `real failure was dropped: ${JSON.stringify(patterns)}`);
    assert.ok(!patterns.some((pattern) => /^mission:/.test(pattern)), `goal line counted as failure: ${JSON.stringify(patterns)}`);
    assert.ok(!patterns.some((pattern) => /"error":\s*null/.test(pattern)), `empty error field counted as failure: ${JSON.stringify(patterns)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Acceptance lines and goal-file stop rules state what done looks like. On
// 2026-10-14 the auto-improver's own acceptance line ("One repeat error fixed
// per loop") was a top repeat problem, and the executor's stop rule ("risk is
// unclear") counted as a missing next step.
test('auto-improver scan skips acceptance lines and goal-file stop rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-goals-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], dir).status, 0);

    const logs = path.join(dir, 'atris', 'team', 'builder', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, `${dateDaysAgo(1)}.md`), [
      '# builder log',
      '- acceptance: One repeat error fixed per loop with a runnable test check.',
      '- acceptance: One repeat error fixed per loop with a runnable test check.',
      '- note: Released by builder: the work ran but its check failed: npm run test:fast',
      '- note: Released by builder: the work ran but its check failed: npm run test:fast',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'builder', 'goals.json'), JSON.stringify({
      goals: [{
        title: 'Ship the handoff',
        acceptance: 'No blocked handoff stays open past a day.',
        stop_rule: 'Stop if proof is missing, risk is unclear, or the next move would require new authority.',
      }],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], dir);
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const signals = JSON.parse(wake.stdout).auto_improver.scan.log_signals;
    const patterns = signals.repeated_failures.map((failure) => failure.pattern);
    assert.ok(patterns.some((pattern) => /check failed/.test(pattern)), `real failure was dropped: ${JSON.stringify(patterns)}`);
    assert.ok(!patterns.some((pattern) => /^acceptance:/.test(pattern)), `acceptance line counted as failure: ${JSON.stringify(patterns)}`);
    assert.ok(!signals.unclear_next_actions.some((item) => /stop_rule|No blocked handoff/.test(item.text)), `goal file counted as unclear: ${JSON.stringify(signals.unclear_next_actions)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// On 2026-10-14 a saved-report file name ("...-a-single-unknown-word-...json")
// and "learned:" / "why:" lines quoting "unclear" were most of the live
// missing-next-step count, so it never reflected real open asks.
test('auto-improver scan skips file names and look-back lines in the unclear count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-unclear-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], dir).status, 0);

    const logs = path.join(dir, 'atris', 'team', 'builder', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, `${dateDaysAgo(1)}.md`), [
      '# builder log',
      '- receipt: atris/runs/mission-2026-10-14-a-single-unknown-word-never--8d6098be.json',
      '- learned: never act on an unknown merge state; ask again a few seconds later.',
      '- why: the stop rule "risk is unclear" counted as a missing next step.',
      '- next: owner unclear for the stale lock cleanup',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], dir);
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const signals = JSON.parse(wake.stdout).auto_improver.scan.log_signals;
    const texts = signals.unclear_next_actions.map((item) => item.text);
    assert.deepEqual(texts, ['- next: owner unclear for the stale lock cleanup']);
    assert.equal(signals.unclear_next_action_count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Mission driver logs carry no date in their name, so the 7-day window never
// applied to them. On 2026-10-14, 4 of the 11 scan findings came from driver
// logs last written in July and August.
test('auto-improver scan dates undated logs by when they were last written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-undated-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], dir).status, 0);

    const logs = path.join(dir, 'atris', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const oldLog = path.join(logs, 'mission-0ld0ld00-driver.log');
    fs.writeFileSync(oldLog, '"error": "review_lane_run_unparseable",\n"error": "review_lane_run_unparseable",\n', 'utf8');
    const twoMonthsAgo = new Date(Date.now() - 60 * 864e5);
    fs.utimesSync(oldLog, twoMonthsAgo, twoMonthsAgo);
    fs.writeFileSync(path.join(logs, 'mission-n3wn3w00-driver.log'), '"error": "engine_exit_nonzero",\n"error": "engine_exit_nonzero",\n', 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], dir);
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const failures = JSON.parse(wake.stdout).auto_improver.scan.log_signals.repeated_failures;
    const patterns = failures.map((failure) => failure.pattern);
    assert.ok(!patterns.some((pattern) => /review_lane_run_unparseable/.test(pattern)), `two-month-old log counted: ${JSON.stringify(patterns)}`);
    const fresh = failures.find((failure) => /engine_exit_nonzero/.test(failure.pattern));
    assert.ok(fresh, `fresh undated log was dropped: ${JSON.stringify(patterns)}`);
    assert.equal(fresh.evidence[0].date, new Date().toISOString().slice(0, 10));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
