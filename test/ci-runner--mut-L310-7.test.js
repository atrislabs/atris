'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCiRunner, runnerAssetName } = require('../lib/ci-runner');

// The default runner version is not exported, but the default asset name carries it.
function defaultTarget() {
  try {
    const asset = runnerAssetName(process.platform, process.arch);
    const match = /^actions-runner-(osx|linux)-(x64|arm64)-(.+)\.tar\.gz$/.exec(asset);
    return match ? { runnerPlatform: match[1], arch: match[2], version: match[3] } : null;
  } catch (_) {
    return null;
  }
}

const target = defaultTarget();

test('runCiRunner looks for the runner under the default version folder', { skip: !target }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ci-runner-mut-'));
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const runnerDir = path.join(
      home, '.atris', 'ci', target.version, `${target.runnerPlatform}-${target.arch}`,
    );
    fs.mkdirSync(runnerDir, { recursive: true });
    fs.writeFileSync(path.join(runnerDir, 'run.sh'), '#!/bin/sh\n');

    const seen = [];
    const logs = [];
    const completed = await runCiRunner({
      repos: [{ owner: 'a', repo: 'x', slug: 'a/x' }],
      label: null,
      once: true,
    }, {
      resolveGithubToken: () => 'token',
      hostname: () => 'test-host',
      ensureRepoRunnerDirectory: (dir) => {
        seen.push(dir);
        return dir;
      },
      runJobLoop: async () => 1,
      log: (line) => logs.push(line),
    });

    assert.equal(completed, 1);
    assert.deepEqual(seen, [runnerDir]);
    assert.deepEqual(logs, []);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
