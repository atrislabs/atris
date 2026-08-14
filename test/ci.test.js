'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildJitConfigRequest,
  formatUsageSummary,
  parseRunnerMarker,
  parseRunnerArgs,
  parseUsageArgs,
  runCiRunner,
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
    repos: [{ owner: 'atrislabs', repo: 'atris', slug: 'atrislabs/atris' }],
    label: 'apple-silicon',
    once: true,
  });
  assert.deepEqual(parseRunnerArgs(['--once', '--repo', 'owner/repo_name']), {
    repos: [{ owner: 'owner', repo: 'repo_name', slug: 'owner/repo_name' }],
    label: null,
    once: true,
  });
});

test('parses repeated repositories and rejects duplicates', () => {
  assert.deepEqual(parseRunnerArgs(['--repo', 'a/x', '--repo', 'b/y', '--once']), {
    repos: [
      { owner: 'a', repo: 'x', slug: 'a/x' },
      { owner: 'b', repo: 'y', slug: 'b/y' },
    ],
    label: null,
    once: true,
  });
  assert.throws(
    () => parseRunnerArgs(['--repo', 'a/x', '--repo', 'A/X']),
    /duplicate --repo: A\/X/,
  );
});

test('parses runner job markers without clock or process state', () => {
  assert.deepEqual(parseRunnerMarker('2026-08-13T12:00:00Z: Running job: tests'), { type: 'start' });
  assert.deepEqual(
    parseRunnerMarker('Job tests completed with result: Succeeded'),
    { type: 'complete', result: 'succeeded' },
  );
  assert.deepEqual(
    parseRunnerMarker('Job tests completed with result: FAILED after 2s'),
    { type: 'complete', result: 'failed' },
  );
  assert.equal(parseRunnerMarker('Listening for Jobs'), null);
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

test('runs each repository from its own runner directory', async (t) => {
  const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ci-runner-'));
  t.after(() => fs.rmSync(runnerDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(runnerDir, 'bin'));
  fs.writeFileSync(path.join(runnerDir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(runnerDir, 'bin', 'Runner.Listener'), 'runner');
  const loops = [];

  const completed = await runCiRunner({
    repos: [
      { owner: 'a', repo: 'x', slug: 'a/x' },
      { owner: 'b', repo: 'y', slug: 'b/y' },
    ],
    label: null,
    once: true,
  }, {
    resolveGithubToken: () => 'token',
    ensureRunner: async () => runnerDir,
    hostname: () => 'test-host',
    runJobLoop: async (options) => {
      loops.push(options);
      return 1;
    },
    log: () => {},
  });

  assert.equal(completed, 2);
  assert.equal(loops.length, 2);
  const directories = new Map(loops.map((loop) => [loop.repo.slug, loop.runnerDir]));
  assert.equal(directories.get('a/x'), path.join(runnerDir, 'repos', 'a', 'x'));
  assert.equal(directories.get('b/y'), path.join(runnerDir, 'repos', 'b', 'y'));
  assert.notEqual(directories.get('a/x'), directories.get('b/y'));
  assert.notEqual(
    path.join(directories.get('a/x'), '_work'),
    path.join(directories.get('b/y'), '_work'),
  );
  assert.equal(fs.existsSync(path.join(directories.get('a/x'), 'run.sh')), true);
  assert.equal(fs.existsSync(path.join(directories.get('b/y'), 'bin', 'Runner.Listener')), true);
  assert.deepEqual(loops.map((loop) => loop.logPrefix), ['a/x: ', 'b/y: ']);
});

test('waits for every repository loop before reporting loop failures', async () => {
  const events = [];
  const logs = [];

  await assert.rejects(runCiRunner({
    repos: [
      { owner: 'a', repo: 'x', slug: 'a/x' },
      { owner: 'b', repo: 'y', slug: 'b/y' },
    ],
    label: null,
    once: true,
  }, {
    resolveGithubToken: () => 'token',
    ensureRunner: async () => '/runner',
    ensureRepoRunnerDirectory: (_runnerDir, repo) => `/runner/${repo.owner}/${repo.repo}`,
    hostname: () => 'test-host',
    runJobLoop: async (options, dependencies) => {
      dependencies.log('loop started');
      if (options.repo.slug === 'a/x') throw new Error('worker broke');
      await new Promise((resolve) => setImmediate(resolve));
      events.push('b/y finished');
      return 1;
    },
    log: (line) => logs.push(line),
  }), /1 ci runner loop failed/);

  assert.deepEqual(events, ['b/y finished']);
  assert.deepEqual(logs, [
    'a/x: loop started',
    'b/y: loop started',
    'a/x: worker broke',
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
    runWorker: async () => ({
      startedAt: times.shift(),
      finishedAt: times.shift(),
      result: 'Succeeded',
    }),
    clock: () => {
      throw new Error('fallback clock should not be used when markers exist');
    },
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
    result: 'succeeded',
  });
});

test('records zero job time before an unmarked worker error propagates', async () => {
  const time = new Date('2026-08-13T12:00:05.000Z');
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
    clock: () => time,
    usagePath: path.join(os.tmpdir(), 'atris-ci-error-usage.jsonl'),
    appendUsage: async (_file, line) => events.push(JSON.parse(line)),
    log: () => {},
  }), /worker failed/);

  assert.deepEqual(events, [
    'worker error',
    {
      repo: 'owner/repo',
      started_at: '2026-08-13T12:00:05.000Z',
      duration_seconds: 0,
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

test('renders per-repository result counts while preserving old usage lines', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');
  const withResults = summarizeUsage([
    { repo: 'owner/app', started_at: '2026-08-01T00:00:00.000Z', duration_seconds: 1, result: 'succeeded' },
    { repo: 'owner/app', started_at: '2026-08-02T00:00:00.000Z', duration_seconds: 2, result: 'SUCCEEDED' },
    { repo: 'owner/app', started_at: '2026-08-03T00:00:00.000Z', duration_seconds: 3, result: 'failed' },
  ], { now });
  assert.deepEqual(withResults.repos, [{
    repo: 'owner/app',
    jobs: 3,
    minutes: 3,
    results: { succeeded: 2, failed: 1 },
  }]);
  assert.equal(formatUsageSummary(withResults), [
    'total jobs: 3',
    'total minutes: 3',
    'minutes this month: 3',
    'per repo:',
    'owner/app: 3 jobs, 2 succeeded, 1 failed, 3 minutes',
  ].join('\n'));

  const legacy = summarizeUsage([
    { repo: 'owner/legacy', started_at: '2026-08-04T00:00:00.000Z', duration_seconds: 61 },
  ], { now });
  assert.deepEqual(legacy.repos, [{ repo: 'owner/legacy', jobs: 1, minutes: 2 }]);
  assert.equal(
    formatUsageSummary(legacy).split('\n').at(-1),
    'owner/legacy: 1 job, 2 minutes',
  );
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
