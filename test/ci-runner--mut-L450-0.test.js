'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runJobLoop } = require('../lib/ci-runner');

test('records the completed job result from worker output', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worker-result-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.writeFileSync(path.join(home, 'run.sh'), [
      '#!/bin/sh',
      "printf '%s\\n' 'Running job: tests' 'Job tests completed with result: Succeeded'",
      '',
    ].join('\n'), { mode: 0o755 });
    let record;
    await runJobLoop({
      repo: { owner: 'owner', repo: 'app', slug: 'owner/app' },
      token: 'local-fixture',
      runnerDir: home,
      runnerName: 'local-fixture',
      once: true,
    }, {
      generateJitConfig: async () => 'local-fixture',
      clock: () => new Date('2026-01-15T12:00:00.000Z'),
      usagePath: path.join(home, 'usage.jsonl'),
      appendUsage: async (_file, line) => { record = JSON.parse(line); },
      log: () => {},
    });
    assert.strictEqual(record.result, 'succeeded');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
