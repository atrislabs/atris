const test = require('node:test');
const assert = require('node:assert/strict');
const { formatUsageSummary } = require('../lib/ci-runner');

test('usage summary sorts unrecognized results alphabetically', () => {
  const summary = {
    totalJobs: 2,
    totalMinutes: 2,
    monthMinutes: 2,
    repos: [{
      repo: 'example/project',
      jobs: 2,
      minutes: 2,
      results: { zebra: 1, alpha: 1 },
    }],
  };

  assert.equal(formatUsageSummary(summary), [
    'total jobs: 2',
    'total minutes: 2',
    'minutes this month: 2',
    'per repo:',
    'example/project: 2 jobs, 1 alpha, 1 zebra, 2 minutes',
  ].join('\n'));
});
