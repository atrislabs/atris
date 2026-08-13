'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildJitConfigRequest,
  parseRunnerArgs,
  runJobLoop,
  runnerAssetName,
} = require('../lib/ci-runner');

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
