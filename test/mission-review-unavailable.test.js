'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recordMissionTickRosterRun, engineVerifierResultFromRun, runVerifier } = require('../commands/mission');
const { readRosterRuns, summarizeRuns, runView } = require('../lib/roster-runs');
const { loadRouterHistory } = require('../lib/router-brain');
const { attachSuggestions } = require('../lib/roster-suggest');

test('a passed check with an unavailable review is recorded and displayed without blaming the builder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-result-'));
  try {
    const at = new Date().toISOString();
    const passed = runVerifier('node -e "process.exit(0)"', root);
    const failed = runVerifier('node -e "process.exit(1)"', root);
    function record(verifierResult) {
      recordMissionTickRosterRun(root, { mission: { id: 'example', owner: 'builder' }, engineId: 'codex', result: { status: 'ran' }, verifierResult, startedAt: at, endedMs: Date.now() });
    }
    const unavailable = engineVerifierResultFromRun({ ok: false, error: 'not installed' });
    const timeout = engineVerifierResultFromRun({ ok: false, timedOut: true });
    record({ ...passed, passed: false, referee: unavailable });
    record({ ...passed, passed: false, referee: timeout });
    record({ ...failed, referee: unavailable });
    record({ ...passed, passed: false, referee: engineVerifierResultFromRun({ ok: true, result: 'VERDICT: FAIL' }) });
    record({ ...passed, passed: false, referee: { ...unavailable, reason: 'code changed during review' } });
    record(passed);
    const rows = readRosterRuns(root);
    assert.deepEqual(rows.map(row => row.outcome), ['review unavailable', 'review unavailable', 'failed', 'failed', 'failed', 'landed']);
    assert.match(rows[0].detail, /check passed.*review was unavailable/);
    assert.match(rows[1].detail, /check passed.*review timed out/);
    assert.match(runView(rows[0]).detail, /check passed/);
    const summary = summarizeRuns(rows);
    assert.equal(summary.failed, 3);
    assert.equal(summary.review_unavailable, 2);
    assert.match(summary.text, /2 review unavailable/);
    assert.deepEqual(loadRouterHistory(root).map(row => row.verified_passed), [false, false, false, true]);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'engine', 'roster', '--runs', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /review unavailable/);
    assert.match(cli.stdout, /build check passed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unavailable reviews do not trigger a roster replacement suggestion', () => {
  const jobs = [{ job: 'build', pick: { engine: 'codex' }, workers: [{ engine: 'codex' }, { engine: 'claude' }] }];
  const rows = ['landed', 'review unavailable', 'review unavailable', 'review unavailable'].map(outcome => ({ at: new Date().toISOString(), job: 'build', engine: 'codex', outcome }));
  rows.push(...[1, 2].map(() => ({ at: new Date().toISOString(), job: 'build', engine: 'claude', outcome: 'landed' })));
  assert.equal(attachSuggestions(jobs, rows), 0);
});
