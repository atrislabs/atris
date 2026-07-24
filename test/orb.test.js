'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const {
  readOrbScorecard,
  renderOrbScorecard,
  parseOrbScorecardDays,
} = require('../lib/orb-scorecard');
const {
  formatJobNotification,
} = require('../commands/orb');
const pulse = require('../lib/pulse');
const { refreshOrbPolicyLessons } = require('../commands/pulse');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

test('orb --once prints deterministic suggestions without spawning an engine', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-'));
  try {
    const stateDir = path.join(fixture, '.atris', 'state');
    const fakeBin = path.join(fixture, 'bin');
    const spawnMarker = path.join(fixture, 'engine-spawned');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });

    const nowText = '# Now\n\n2026-07-18 shipped the fixture.\n';
    fs.writeFileSync(path.join(fixture, 'now.md'), nowText);
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        { display_id: 'CLI-1154', title: 'Build the Orb CLI loop', status: 'open', updated_at: '2026-07-18T09:00:00.000Z' },
        { display_id: 'CLI-1153', title: 'Review the desktop Orb proof', status: 'review', updated_at: '2026-07-18T10:00:00.000Z' },
      ],
    }));

    for (const engine of ['claude', 'codex', 'ax']) {
      const executable = path.join(fakeBin, engine);
      fs.writeFileSync(executable, '#!/bin/sh\nprintf spawned >> "$ORB_SPAWN_MARKER"\n');
      fs.chmodSync(executable, 0o755);
    }

    const result = spawnSync(process.execPath, [cliPath, 'orb', '--once'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...scrubAgentEnv(),
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ORB_SPAWN_MARKER: spawnMarker,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    });

    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^1\. /m);
    assert.match(result.stdout, /Review the desktop Orb proof/);
    assert.equal(fs.existsSync(spawnMarker), false, 'no engine executable was spawned');
    assert.equal(fs.existsSync(path.join(stateDir, 'orb-runs')), false, 'no background run was created');
    assert.equal(fs.readFileSync(path.join(fixture, 'now.md'), 'utf8'), nowText, 'once mode leaves now.md unchanged');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('orb scorecard keeps legacy terminal records unchanged for a deterministic window', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-scorecard-'));
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  try {
    assert.deepEqual(parseOrbScorecardDays([]), { ok: true, days: 7 });
    assert.deepEqual(parseOrbScorecardDays(['--days', '3']), { ok: true, days: 3 });
    const nowPath = path.join(fixture, 'now.md');
    const indexPath = path.join(fixture, '.atris', 'state', 'orb-runs', 'index.jsonl');
    fs.writeFileSync(nowPath, [
      '# Now',
      'orb: review the proof · 2026-07-18',
      'orb: repair the worker · 2026-07-12',
      'orb: stale pick · 2026-07-10',
      '',
    ].join('\n'), 'utf8');
    writeJsonl(indexPath, [
      { ts: '2026-07-18T10:00:00.000Z', label: 'review the proof', kind: 'review', engine: 'claude', exitCode: 0, durationMs: 1000, logPath: 'one.log' },
      { ts: '2026-07-17T10:00:00.000Z', label: 'repair the worker', kind: 'freeform', engine: 'codex', exitCode: 2, durationMs: 3000, logPath: 'two.log' },
      { ts: '2026-07-16T10:00:00.000Z', label: 'check the task', kind: 'review', engine: 'claude', exitCode: 0, durationMs: 2000, logPath: 'three.log' },
      { ts: '2026-07-01T10:00:00.000Z', label: 'old failure', kind: 'task', engine: 'fast', exitCode: 1, durationMs: 9999, logPath: 'old.log' },
    ]);
    const beforeIndex = fs.readFileSync(indexPath, 'utf8');
    const beforeNow = fs.readFileSync(nowPath, 'utf8');

    const scorecard = readOrbScorecard(fixture, { days: 7, now });
    assert.equal(scorecard.picks, 2);
    assert.equal(scorecard.dispatches, 3);
    assert.deepEqual(scorecard.dispatches_by_kind, { freeform: 1, review: 2 });
    assert.deepEqual(scorecard.dispatches_by_engine, { claude: 2, codex: 1 });
    assert.equal(scorecard.ok, 2);
    assert.equal(scorecard.fail, 1);
    assert.equal(scorecard.orphaned, 0);
    assert.equal(scorecard.completion_rate, 2 / 3);
    assert.equal(scorecard.median_duration_ms, 2000);
    assert.deepEqual(scorecard.failures.map((row) => row.label), ['repair the worker']);
    assert.equal(renderOrbScorecard(scorecard), [
      'orb scorecard: 7 days',
      'picks: 2',
      'dispatches: 3',
      'by kind: freeform 1, review 2',
      'by engine: claude 2, codex 1',
      'outcomes: 2 ok, 1 fail',
      'orphaned: 0',
      'completion rate: 66.7%',
      'median duration: 2000 ms',
    ].join('\n'));
    assert.equal(fs.readFileSync(indexPath, 'utf8'), beforeIndex, 'scorecard leaves the run index unchanged');
    assert.equal(fs.readFileSync(nowPath, 'utf8'), beforeNow, 'scorecard leaves now.md unchanged');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('orb scorecard pairs dispatched and terminal records by log path', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-paired-'));
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  try {
    writeJsonl(path.join(fixture, '.atris', 'state', 'orb-runs', 'index.jsonl'), [
      { status: 'dispatched', ts: '2026-07-18T10:00:00.000Z', label: 'paired job', kind: 'task', engine: 'codex', logPath: 'paired.log', pid: 999999999 },
      { status: 'ready', ts: '2026-07-18T10:00:01.000Z', label: 'paired job', kind: 'task', engine: 'codex', exitCode: 0, durationMs: 1000, logPath: 'paired.log', error: null },
      { status: 'dispatched', ts: '2026-07-18T10:01:00.000Z', label: 'paired legacy job', kind: 'review', engine: 'claude', logPath: 'paired-legacy.log', pid: 999999999 },
      { ts: '2026-07-18T10:01:01.000Z', label: 'paired legacy job', kind: 'review', engine: 'claude', exitCode: 1, durationMs: 2000, logPath: 'paired-legacy.log', error: null },
    ]);

    const scorecard = readOrbScorecard(fixture, { days: 7, now });
    assert.equal(scorecard.dispatches, 2);
    assert.deepEqual(scorecard.dispatches_by_kind, { review: 1, task: 1 });
    assert.equal(scorecard.ok, 1);
    assert.equal(scorecard.fail, 1);
    assert.equal(scorecard.orphaned, 0);
    assert.equal(scorecard.median_duration_ms, 1500);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('orb scorecard counts a dead unmatched dispatch as orphaned and pulse ingests it once', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-orphaned-'));
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  try {
    writeJsonl(path.join(fixture, '.atris', 'state', 'orb-runs', 'index.jsonl'), [
      { status: 'dispatched', ts: '2026-07-18T10:00:00.000Z', label: 'lost job', kind: 'freeform', engine: 'claude', logPath: 'lost.log', pid: 999999999 },
    ]);

    const scorecard = readOrbScorecard(fixture, { days: 7, now });
    assert.equal(scorecard.dispatches, 1);
    assert.equal(scorecard.ok, 0);
    assert.equal(scorecard.fail, 1);
    assert.equal(scorecard.orphaned, 1);
    assert.equal(scorecard.completion_rate, 0);
    assert.deepEqual(scorecard.orphans.map((row) => row.label), ['lost job']);
    assert.match(renderOrbScorecard(scorecard), /^orphaned: 1$/m);

    const first = pulse.ingestOrbScorecard(fixture, { days: 7, now });
    const second = pulse.ingestOrbScorecard(fixture, { days: 7, now });
    assert.equal(first.scorecards_written, 1);
    assert.equal(second.scorecards_written, 0);
    assert.match(first.improvement_candidates[0].next_task, /investigate orphaned orb job "lost job"/);
    assert.equal(first.written[0].mode, 'orb_orphan');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('orb scorecard leaves a live unmatched dispatch out of orphan outcomes', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-live-'));
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  try {
    writeJsonl(path.join(fixture, '.atris', 'state', 'orb-runs', 'index.jsonl'), [
      { status: 'dispatched', ts: '2026-07-18T10:00:00.000Z', label: 'live job', kind: 'review', engine: 'codex', logPath: 'live.log', pid: process.pid },
    ]);

    const scorecard = readOrbScorecard(fixture, { days: 7, now });
    assert.equal(scorecard.dispatches, 1);
    assert.equal(scorecard.ok, 0);
    assert.equal(scorecard.fail, 0);
    assert.equal(scorecard.orphaned, 0);
    assert.equal(scorecard.completion_rate, null);
    assert.deepEqual(scorecard.orphans, []);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('orb scorecard command prints the native summary without writing', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-scorecard-cli-'));
  try {
    const ts = new Date().toISOString();
    const day = ts.slice(0, 10);
    const indexPath = path.join(fixture, '.atris', 'state', 'orb-runs', 'index.jsonl');
    fs.writeFileSync(path.join(fixture, 'now.md'), `# Now\norb: ship the reader · ${day}\n`, 'utf8');
    writeJsonl(indexPath, [
      { ts, label: 'ship the reader', kind: 'task', engine: 'codex', exitCode: 0, durationMs: 125, logPath: 'reader.log' },
    ]);
    const before = fs.readFileSync(indexPath, 'utf8');
    const result = spawnSync(process.execPath, [cliPath, 'orb', 'scorecard', '--days', '7'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^orb scorecard: 7 days/m);
    assert.match(result.stdout, /^picks: 1$/m);
    assert.match(result.stdout, /^by engine: codex 1$/m);
    assert.match(result.stdout, /^outcomes: 1 ok, 0 fail$/m);
    assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('orb job notification renders failed exits and launch errors distinctly', () => {
  assert.equal(
    formatJobNotification({ label: 'green job', exitCode: 0, error: null }),
    '✔ ready: green job (o to open)',
  );
  assert.equal(
    formatJobNotification({ label: 'red job', exitCode: 2, error: null }),
    '✗ failed: red job (o to open)',
  );
  assert.equal(
    formatJobNotification({ label: 'missing engine', exitCode: 1, error: 'spawn ENOENT' }),
    '✗ failed: missing engine (o to open)',
  );
});

test('orb startup warns before picks when the selected engine binary is missing', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-missing-engine-'));
  try {
    const emptyBin = path.join(fixture, 'empty-bin');
    fs.mkdirSync(path.join(fixture, '.atris'), { recursive: true });
    fs.mkdirSync(emptyBin);
    fs.writeFileSync(path.join(fixture, 'now.md'), '# Now\n', 'utf8');
    const result = spawnSync(process.execPath, [cliPath, 'orb', '--once', '--engine', 'claude'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...scrubAgentEnv(),
        ATRIS_SKIP_UPDATE_CHECK: '1',
        PATH: emptyBin,
      },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /orb warning: engine binary "claude" is missing from PATH; picks will fail/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('pulse ingests each orb failure once and mines an actionable fail lesson', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-pulse-'));
  const now = new Date('2026-07-18T12:00:00.000Z');
  try {
    fs.mkdirSync(path.join(fixture, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'now.md'), 'orb: repair the launch · 2026-07-18\n', 'utf8');
    writeJsonl(path.join(fixture, '.atris', 'state', 'orb-runs', 'index.jsonl'), [
      {
        ts: '2026-07-18T10:00:00.000Z',
        label: 'repair the launch',
        kind: 'freeform',
        engine: 'claude',
        exitCode: 1,
        durationMs: 25,
        logPath: '.atris/state/orb-runs/failed.log',
        error: 'spawn claude ENOENT',
      },
    ]);

    const first = pulse.ingestOrbScorecard(fixture, { days: 7, now });
    const second = pulse.ingestOrbScorecard(fixture, { days: 7, now });
    assert.equal(first.summary.fail, 1);
    assert.equal(first.scorecards_written, 1);
    assert.equal(second.scorecards_written, 0, 'the existing scorecard row dedupes the same orb run');
    assert.match(first.improvement_candidates[0].next_task, /investigate failed orb job "repair the launch"/);

    const rows = pulse.readJsonl(pulse.scorecardsPath(fixture));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].schema, 'atris.improve_tick.v1');
    assert.equal(rows[0].source, 'orb');
    assert.equal(rows[0].reward, -1);
    assert.equal(rows[0].orb_exit_code, 1);

    const policy = refreshOrbPolicyLessons(fixture, second, now);
    assert.equal(policy.status, 'fail');
    const lessons = fs.readFileSync(path.join(fixture, 'atris', 'lessons.md'), 'utf8');
    assert.match(lessons, /policy-orb-job-failures\*\* .* fail/);
    assert.match(lessons, /`commands\/orb\.js`/);
    assert.match(lessons, /failed\.log/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('orb choice appends to atris/now.md, not a stray root now.md', async () => {
  const { appendOrbChoice } = require('../lib/orb-context');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-now-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const res = await appendOrbChoice(root, 'ship the fix', new Date('2026-07-24T00:00:00Z'));
  assert.ok(res.ok);
  assert.ok(fs.readFileSync(path.join(root, 'atris', 'now.md'), 'utf8').includes('orb: ship the fix'));
  assert.ok(!fs.existsSync(path.join(root, 'now.md')), 'no stray root now.md');
});
