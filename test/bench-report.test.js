'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildBenchReport, renderBenchReportText } = require('../lib/bench/report');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-report-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeResultsJsonl(stateRoot, records) {
  const dir = path.join(stateRoot, '.atris', 'state', 'bench');
  fs.mkdirSync(dir, { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'results.jsonl'), body, 'utf8');
}

// One real task id per agents-v1 category, so category grouping can be
// asserted against the pack's actual check.js category field.
const NAVIGATE_TASK = 'count-cli-commands';
const EDIT_TASK = 'fix-failing-test';
const CONTRACT_TASK = 'no-commit-rule';
const BUILD_TASK = 'add-json-flag';
const RECOVER_TASK = 'merge-conflict';
const ALL_FIVE = [NAVIGATE_TASK, EDIT_TASK, CONTRACT_TASK, BUILD_TASK, RECOVER_TASK];

function task(id, passed, durationMs, skipped = false) {
  return {
    id,
    passed,
    skipped,
    failures: passed ? [] : [`${id} failed`],
    duration_ms: durationMs,
    retried: false,
  };
}

function fullRunRecord({ engine, started, finished, tasks }) {
  const passed = tasks.filter((t) => t.passed && !t.skipped).map((t) => t.id);
  const failed = tasks.filter((t) => !t.passed && !t.skipped).map((t) => t.id);
  const skipped = tasks.filter((t) => t.skipped).map((t) => t.id);
  return {
    schema: 'atris.bench.run.v1',
    pack: 'agents-v1',
    engine,
    label: null,
    experiment: null,
    started,
    finished,
    tasks,
    passed,
    failed,
    skipped,
    summary: `${passed.length}/${passed.length + failed.length} gate cases passed`,
  };
}

test('groups by engine, keeps the latest full run, and computes category counts', () => {
  const stateRoot = makeTempDir();
  try {
    // engine "codex": two full runs (5 synthetic tasks standing in for the pack).
    // The report must use the LATER run's results, not the earlier one.
    const codexEarly = fullRunRecord({
      engine: 'codex',
      started: '2026-07-01T00:00:00.000Z',
      finished: '2026-07-01T00:01:00.000Z',
      tasks: [
        task(NAVIGATE_TASK, false, 1000),
        task(EDIT_TASK, false, 1000),
        task(CONTRACT_TASK, false, 1000),
        task(BUILD_TASK, false, 1000),
        task(RECOVER_TASK, false, 1000),
      ],
    });
    const codexLatest = fullRunRecord({
      engine: 'codex',
      started: '2026-07-02T00:00:00.000Z',
      finished: '2026-07-02T00:02:00.000Z',
      tasks: [
        task(NAVIGATE_TASK, true, 2000),
        task(EDIT_TASK, true, 4000),
        task(CONTRACT_TASK, false, 3000),
        task(BUILD_TASK, true, 1000),
        task(RECOVER_TASK, false, 6000),
      ],
    });

    // engine "atris-fast": two PARTIAL runs (no full run ever recorded), so the
    // report must merge them, with the later run winning on overlapping ids.
    const partialA = fullRunRecord({
      engine: 'atris-fast',
      started: '2026-07-01T00:00:00.000Z',
      finished: '2026-07-01T00:00:30.000Z',
      tasks: [
        task(NAVIGATE_TASK, true, 500),
        task(EDIT_TASK, false, 500),
      ],
    });
    const partialB = fullRunRecord({
      engine: 'atris-fast',
      started: '2026-07-01T01:00:00.000Z',
      finished: '2026-07-01T01:00:30.000Z',
      tasks: [
        task(EDIT_TASK, true, 1500), // overrides partialA's failing result
        task(CONTRACT_TASK, true, 500),
      ],
    });

    writeResultsJsonl(stateRoot, [codexEarly, codexLatest, partialA, partialB]);

    const report = buildBenchReport({ repoRoot, stateRoot, pack: 'agents-v1' });

    assert.equal(report.schema, 'atris.bench.report.v1');
    assert.equal(report.pack, 'agents-v1');
    assert.deepEqual(report.engines.map((e) => e.engine), ['atris-fast', 'codex']);

    const codex = report.engines.find((e) => e.engine === 'codex');
    // latest-run-wins: codexLatest, not codexEarly, drives the numbers
    assert.equal(codex.passed, 3);
    assert.equal(codex.total, 25);
    assert.deepEqual(codex.failed.sort(), [CONTRACT_TASK, RECOVER_TASK].sort());
    assert.equal(codex.skipped, 0);
    assert.equal(codex.meanDurationMs, Math.round((2000 + 4000 + 3000 + 1000 + 6000) / 5));

    const byCategory = Object.fromEntries(codex.categories.map((c) => [c.name, c]));
    assert.equal(byCategory.navigate.passed, 1);
    assert.equal(byCategory.navigate.total, 5);
    assert.equal(byCategory.edit.passed, 1);
    assert.equal(byCategory.contract.passed, 0);
    assert.equal(byCategory.build.passed, 1);
    assert.equal(byCategory.recover.passed, 0);

    const atrisFast = report.engines.find((e) => e.engine === 'atris-fast');
    // merged partial runs: navigate (from A), edit (B overrides A -> passed), contract (from B)
    assert.equal(atrisFast.total, 25);
    assert.equal(atrisFast.passed, 3);
    assert.deepEqual(atrisFast.failed, []);
    const atrisFastByCategory = Object.fromEntries(atrisFast.categories.map((c) => [c.name, c]));
    assert.equal(atrisFastByCategory.edit.passed, 1, 'later partial run must win on overlapping task id');
  } finally {
    cleanupTempDir(stateRoot);
  }
});

test('json report has the schema shape from the design doc', () => {
  const stateRoot = makeTempDir();
  try {
    writeResultsJsonl(stateRoot, [
      fullRunRecord({
        engine: 'solution',
        started: '2026-07-01T00:00:00.000Z',
        finished: '2026-07-01T00:01:00.000Z',
        tasks: ALL_FIVE.map((id) => task(id, true, 1000)),
      }),
    ]);
    const report = buildBenchReport({ repoRoot, stateRoot, pack: 'agents-v1' });
    assert.deepEqual(Object.keys(report), ['schema', 'pack', 'engines']);
    assert.equal(report.schema, 'atris.bench.report.v1');
    assert.equal(report.engines.length, 1);
    assert.deepEqual(Object.keys(report.engines[0]), [
      'engine',
      'passed',
      'total',
      'categories',
      'meanDurationMs',
      'failed',
      'skipped',
    ]);
    assert.deepEqual(Object.keys(report.engines[0].categories[0]), ['name', 'passed', 'total']);
    assert.deepEqual(report.engines[0].categories.map((c) => c.name), [
      'navigate',
      'edit',
      'contract',
      'build',
      'recover',
    ]);
  } finally {
    cleanupTempDir(stateRoot);
  }
});

test('skipped tasks count separately and do not skew mean duration', () => {
  const stateRoot = makeTempDir();
  try {
    writeResultsJsonl(stateRoot, [
      fullRunRecord({
        engine: 'atris-fast',
        started: '2026-07-01T00:00:00.000Z',
        finished: '2026-07-01T00:00:05.000Z',
        tasks: [
          task(NAVIGATE_TASK, false, 10, true),
          task(EDIT_TASK, false, 10, true),
          task(CONTRACT_TASK, true, 1000),
          task(BUILD_TASK, false, 1000),
          task(RECOVER_TASK, false, 10, true),
        ],
      }),
    ]);
    const report = buildBenchReport({ repoRoot, stateRoot, pack: 'agents-v1' });
    const engine = report.engines[0];
    assert.equal(engine.skipped, 3);
    assert.equal(engine.passed, 1);
    assert.deepEqual(engine.failed, [BUILD_TASK]);
    assert.equal(engine.meanDurationMs, 1000, 'mean should only count attempted (non-skipped) tasks');
  } finally {
    cleanupTempDir(stateRoot);
  }
});

test('empty results: buildBenchReport and renderBenchReportText never throw', () => {
  const stateRoot = makeTempDir();
  try {
    const report = buildBenchReport({ repoRoot, stateRoot, pack: 'agents-v1' });
    assert.deepEqual(report, { schema: 'atris.bench.report.v1', pack: 'agents-v1', engines: [] });
    assert.equal(renderBenchReportText(report), 'no runs recorded for pack agents-v1');
  } finally {
    cleanupTempDir(stateRoot);
  }
});

test('cli: empty state exits 0 with a plain no-runs line, never a stack trace', () => {
  const stateRoot = makeTempDir();
  try {
    const result = spawnSync(process.execPath, [cliPath, 'bench', 'report', '--pack', 'agents-v1'], {
      cwd: stateRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no runs recorded/);
    assert.doesNotMatch(result.stderr, /at .*\.js:\d+/);
  } finally {
    cleanupTempDir(stateRoot);
  }
});

test('cli: --json emits the atris.bench.report.v1 envelope', () => {
  const stateRoot = makeTempDir();
  try {
    writeResultsJsonl(stateRoot, [
      fullRunRecord({
        engine: 'solution',
        started: '2026-07-01T00:00:00.000Z',
        finished: '2026-07-01T00:01:00.000Z',
        tasks: ALL_FIVE.map((id) => task(id, true, 1000)),
      }),
    ]);
    const result = spawnSync(process.execPath, [cliPath, 'bench', 'report', '--pack', 'agents-v1', '--json'], {
      cwd: stateRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.schema, 'atris.bench.report.v1');
    assert.equal(parsed.pack, 'agents-v1');
    assert.equal(parsed.engines[0].engine, 'solution');
  } finally {
    cleanupTempDir(stateRoot);
  }
});
