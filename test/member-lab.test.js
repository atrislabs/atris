'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roundSummaries, summarize } = require('../scripts/member-lab-summary');

test('summaries calculate build times and project changes per round', () => {
  const rows = [
    { arm: 'member', rep: 1, task: '06-test', passed: true, secs: 12, build_seconds: [10], code_lines_changed: 5 },
    { arm: 'member', rep: 1, task: '09-test', passed: false, secs: 32, build_seconds: [30], code_lines_changed: 5 },
    { arm: 'member', rep: 2, task: '06-test', passed: true, secs: 8, build_seconds: [7, 3, 5], code_lines_changed: 0 },
    { arm: 'bare', rep: 1, task: '06-test', passed: false, infra_error: 'rate limit', secs: 90 },
  ];
  assert.deepEqual(roundSummaries(rows), [
    { arm: 'member', rep: 1, build_median_seconds: 20, build_average_seconds: 20, tasks: [{ task: '06-test', code_lines_changed: 5 }, { task: '09-test', code_lines_changed: 5 }] },
    { arm: 'member', rep: 2, build_median_seconds: 5, build_average_seconds: 5, tasks: [{ task: '06-test', code_lines_changed: 0 }] },
    { arm: 'bare', rep: 1, build_median_seconds: null, build_average_seconds: null, tasks: [{ task: '06-test', code_lines_changed: null }] },
  ]);
  const output = summarize(rows);
  assert.match(output, /member: 2\/3 passed \(67%\)/);
  assert.match(output, /bare: 0\/0 passed \(0%\), 1 engine failures left out/);
  assert.match(output, /member round 1: build median 20s, average 20s; code lines changed: 06-test 5, 09-test 5/);
  assert.match(output, /bare round 1: build median unavailable, average unavailable; code lines changed: 06-test unknown/);
});
