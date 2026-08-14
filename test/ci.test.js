'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildJitConfigRequest,
  formatUsageSummary,
  parseRunnerArgs,
  parseUsageArgs,
  runJobLoop,
  runnerAssetName,
  summarizeUsage,
} = require('../lib/ci-runner');
const { ciCommand } = require('../commands/ci');

function injectedMeter() {
  let now = Date.parse('2026-08-13T12:00:00.000Z');
  return {
    usagePath: path.join(os.tmpdir(), 'atris-ci-unused-usage.jsonl'),
    appendUsage: () => {},
    clock: () => {
      const value = new Date(now);
      now += 1000;
      return value;
    },
  };
}

test('selects the official runner tarball for each supported machine', () => {
  assert.equal(runnerAssetName('darwin', 'x64', '2.336.0'), 'actions-runner-osx-x64-2.336.0.tar.gz');
  assert.equal(runnerAssetName('darwin', 'arm64', '2.336.0'), 'actions-runner-osx-arm64-2.336.0.tar.gz');
  assert.equal(runnerAssetName('linux', 'x64', '2.336.0'), 'actions-runner-linux-x64-2.336.0.tar.gz');
  assert.equal(runnerAssetName('linux', 'arm64', '2.336.0'), 'actions-runner-linux-arm64-2.336.0.tar.gz');
  assert.throws(() => runnerAssetName('win32', 'x64'), /unsupported runner platform/);
  assert.throws(() => runnerAssetName('linux', 'ia32'), /unsupported runner platform/);
});

test('builds the repository jitconfig request path and body', () => {
  assert.deepEqual(
    buildJitConfigRequest({ owner: 'atrislabs', repo: 'atris' }, 'gpu', 'atris-local-1'),
    {
      path: '/repos/atrislabs/atris/actions/runners/generate-jitconfig',
      body: {
        name: 'atris-local-1',
        runner_group_id: 1,
        labels: ['atris', 'gpu'],
        work_folder: '_work',
      },
    },
  );
  assert.deepEqual(
    buildJitConfigRequest({ owner: 'atrislabs', repo: 'atris' }, null, 'atris-local-1').body.labels,
    ['atris'],
  );
});

test('parses owner and repo runner arguments', () => {
  assert.deepEqual(parseRunnerArgs(['--repo', 'atrislabs/atris', '--label', 'apple-silicon', '--once']), {
    repo: { owner: 'atrislabs', repo: 'atris', slug: 'atrislabs/atris' },
    label: 'apple-silicon',
    once: true,
  });
  assert.deepEqual(parseRunnerArgs(['--once', '--repo', 'owner/repo_name']), {
    repo: { owner: 'owner', repo: 'repo_name', slug: 'owner/repo_name' },
    label: null,
    once: true,
  });
});

test('rejects malformed repository and runner arguments', () => {
  const invalid = [
    [],
    ['--repo'],
    ['--repo', 'owner'],
    ['--repo', 'owner/repo/extra'],
    ['--repo', '-owner/repo'],
    ['--repo', 'owner/repo', '--label'],
    ['--repo', 'owner/repo', '--label', 'two words'],
    ['--repo', 'owner/repo', '--wat'],
    ['--repo', 'owner/repo', '--repo', 'other/repo'],
  ];
  for (const args of invalid) assert.throws(() => parseRunnerArgs(args));
});

test('once runs one job and continuous mode asks for another jitconfig', async () => {
  const onceCalls = [];
  const base = {
    repo: { owner: 'owner', repo: 'repo', slug: 'owner/repo' },
    label: null,
    token: 'token',
    runnerDir: '/runner',
    runnerName: 'atris-test',
  };
  const onceJobs = await runJobLoop({ ...base, once: true }, {
    ...injectedMeter(),
    generateJitConfig: async (...args) => {
      onceCalls.push(['mint', args[3]]);
      return 'blob-1';
    },
    runWorker: async (...args) => onceCalls.push(['run', args[1]]),
    log: () => {},
  });
  assert.equal(onceJobs, 1);
  assert.deepEqual(onceCalls, [['mint', 'atris-test-1'], ['run', 'blob-1']]);

  const continuousCalls = [];
  let minted = 0;
  const continuousJobs = await runJobLoop({ ...base, once: false }, {
    ...injectedMeter(),
    generateJitConfig: async (...args) => {
      minted += 1;
      continuousCalls.push(['mint', args[3]]);
      return `blob-${minted}`;
    },
    runWorker: async (...args) => continuousCalls.push(['run', args[1]]),
    shouldContinue: ({ once, completedJobs }) => {
      assert.equal(once, false);
      return completedJobs < 2;
    },
    log: () => {},
  });
  assert.equal(continuousJobs, 2);
  assert.deepEqual(continuousCalls, [
    ['mint', 'atris-test-1'],
    ['run', 'blob-1'],
    ['mint', 'atris-test-2'],
    ['run', 'blob-2'],
  ]);
});

test('records one json usage line with the injected clock, path, and appender', async () => {
  const times = [
    new Date('2026-08-13T12:00:00.000Z'),
    new Date('2026-08-13T12:00:02.250Z'),
  ];
  const writes = [];
  const target = path.join(os.tmpdir(), 'atris-ci-injected-usage.jsonl');

  await runJobLoop({
    repo: { owner: 'owner', repo: 'repo', slug: 'owner/repo' },
    label: null,
    token: 'token',
    runnerDir: '/runner',
    runnerName: 'atris-test',
    once: true,
  }, {
    generateJitConfig: async () => 'blob',
    runWorker: async () => {},
    clock: () => times.shift(),
    usagePath: target,
    appendUsage: async (file, line) => writes.push({ file, line }),
    log: () => {},
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, target);
  assert.equal(writes[0].line.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(writes[0].line), {
    repo: 'owner/repo',
    started_at: '2026-08-13T12:00:00.000Z',
    duration_seconds: 3,
  });
});

test('records usage before a worker error propagates', async () => {
  const times = [
    new Date('2026-08-13T12:00:00.000Z'),
    new Date('2026-08-13T12:00:05.000Z'),
  ];
  const events = [];

  await assert.rejects(runJobLoop({
    repo: { owner: 'owner', repo: 'repo', slug: 'owner/repo' },
    label: null,
    token: 'token',
    runnerDir: '/runner',
    runnerName: 'atris-test',
    once: true,
  }, {
    generateJitConfig: async () => 'blob',
    runWorker: async () => {
      events.push('worker error');
      throw new Error('worker failed');
    },
    clock: () => times.shift(),
    usagePath: path.join(os.tmpdir(), 'atris-ci-error-usage.jsonl'),
    appendUsage: async (_file, line) => events.push(JSON.parse(line)),
    log: () => {},
  }), /worker failed/);

  assert.deepEqual(events, [
    'worker error',
    {
      repo: 'owner/repo',
      started_at: '2026-08-13T12:00:00.000Z',
      duration_seconds: 5,
    },
  ]);
});

test('aggregates rounded job minutes across the calendar month boundary', () => {
  const records = [
    { repo: 'owner/alpha', started_at: '2026-07-31T23:59:59.000Z', duration_seconds: 1 },
    { repo: 'owner/alpha', started_at: '2026-08-01T00:00:00.000Z', duration_seconds: 59 },
    { repo: 'owner/beta', started_at: '2026-08-02T00:00:00.000Z', duration_seconds: 60 },
    { repo: 'owner/beta', started_at: '2026-08-03T00:00:00.000Z', duration_seconds: 61 },
  ];

  assert.deepEqual(summarizeUsage(records, { now: new Date('2026-08-13T12:00:00.000Z') }), {
    totalJobs: 4,
    totalMinutes: 5,
    monthMinutes: 4,
    repos: [
      { repo: 'owner/alpha', jobs: 2, minutes: 2 },
      { repo: 'owner/beta', jobs: 2, minutes: 3 },
    ],
  });
  assert.deepEqual(summarizeUsage(records, {
    repo: 'owner/alpha',
    now: new Date('2026-08-13T12:00:00.000Z'),
  }), {
    totalJobs: 2,
    totalMinutes: 2,
    monthMinutes: 1,
    repos: [{ repo: 'owner/alpha', jobs: 2, minutes: 2 }],
  });
});

test('parses usage repository arguments and rejects unsupported options', () => {
  assert.deepEqual(parseUsageArgs([]), { repo: null });
  assert.deepEqual(parseUsageArgs(['--repo', 'owner/repo']), { repo: 'owner/repo' });
  assert.throws(() => parseUsageArgs(['--repo']), /owner\/name is required/);
  assert.throws(() => parseUsageArgs(['--repo', 'owner']), /owner\/name/);
  assert.throws(() => parseUsageArgs(['--repo', 'owner/repo', '--repo', 'other/repo']), /only be set once/);
  assert.throws(() => parseUsageArgs(['--wat']), /unknown ci usage option/);
});

test('usage command reads the file, filters by repo, and handles a missing file', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ci-usage-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const usagePath = path.join(tempDir, 'usage.jsonl');
  fs.writeFileSync(usagePath, [
    JSON.stringify({ repo: 'owner/alpha', started_at: '2026-08-01T00:00:00.000Z', duration_seconds: 1 }),
    JSON.stringify({ repo: 'owner/beta', started_at: '2026-08-02T00:00:00.000Z', duration_seconds: 61 }),
    '',
  ].join('\n'), 'utf8');
  const output = [];

  assert.equal(await ciCommand(['usage', '--repo', 'owner/beta'], {
    usagePath,
    clock: () => new Date('2026-08-13T12:00:00.000Z'),
    log: (line) => output.push(line),
  }), 0);
  assert.equal(output[0], [
    'total jobs: 1',
    'total minutes: 2',
    'minutes this month: 2',
    'per repo:',
    'owner/beta: 1 job, 2 minutes',
  ].join('\n'));

  const emptyOutput = [];
  assert.equal(await ciCommand(['usage'], {
    usagePath: path.join(tempDir, 'missing.jsonl'),
    clock: () => new Date('2026-08-13T12:00:00.000Z'),
    log: (line) => emptyOutput.push(line),
  }), 0);
  assert.equal(emptyOutput[0], formatUsageSummary(summarizeUsage([], {
    now: new Date('2026-08-13T12:00:00.000Z'),
  })));
  assert.equal(emptyOutput[0], 'no build minutes recorded yet');
});
