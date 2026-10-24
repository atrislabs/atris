'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runCiRunner, runnerAssetName } = require('../lib/ci-runner');

test('runner setup extracts the cached archive with its default process launcher', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ci-extract-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const fixture = path.join(home, 'fixture');
    const cache = path.join(home, '.atris', 'ci');
    fs.mkdirSync(fixture);
    fs.mkdirSync(cache, { recursive: true });
    const script = '#!/bin/sh\nexit 0\n';
    fs.writeFileSync(path.join(fixture, 'run.sh'), script, { mode: 0o644 });
    const archive = path.join(cache, runnerAssetName(process.platform, process.arch));
    const packed = spawnSync('tar', ['-czf', archive, '-C', fixture, 'run.sh'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    assert.equal(packed.status, 0, packed.stderr || packed.error?.message);

    // Keep the real setup path, but replace authentication and job execution.
    // The cached archive prevents downloads; run.sh is inspected, never executed.
    const completed = await runCiRunner({
      repos: [{ owner: 'example', repo: 'project', slug: 'example/project' }],
      once: true,
    }, {
      resolveGithubToken: () => 'local-test-token',
      hostname: () => 'local-test-host',
      log: () => {},
      runJobLoop: async ({ runnerDir }) => {
        const extracted = path.join(runnerDir, 'run.sh');
        assert.equal(fs.readFileSync(extracted, 'utf8'), script);
        assert.equal(fs.statSync(extracted).mode & 0o777, 0o755);
        return 7;
      },
    });
    assert.equal(completed, 7);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
