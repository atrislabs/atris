'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCiRunner } = require('../lib/ci-runner');

const REPO = { owner: 'acme', repo: 'widgets', slug: 'acme/widgets' };

function fakeGhDir(root, body) {
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  const script = [
    '#!/bin/sh',
    'if [ "$1" != "auth" ] || [ "$2" != "token" ]; then exit 64; fi',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'gh'), script, { mode: 0o755 });
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return bin;
}

async function runWithGh(bin) {
  const savedPath = process.env.PATH;
  const savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.PATH = bin;
  const seen = [];
  try {
    await runCiRunner({ repos: [REPO] }, {
      ensureRunner: async () => 'runner-dir',
      ensureRepoRunnerDirectory: () => 'repo-runner-dir',
      hostname: () => 'testhost',
      log: () => {},
      runJobLoop: async (loopOptions) => {
        seen.push(loopOptions.token);
        return 1;
      },
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
  return seen;
}

test('uses the trimmed token that gh prints when gh succeeds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ci-runner-mut-'));
  try {
    const bin = fakeGhDir(root, "printf '  gh-cli-token-123  \\n'\nexit 0");
    const seen = await runWithGh(bin);
    assert.deepEqual(seen, ['gh-cli-token-123']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignores anything gh prints when gh fails and asks for a token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ci-runner-mut-'));
  try {
    const bin = fakeGhDir(root, "printf 'stale-gh-output\\n'\nexit 1");
    await assert.rejects(
      () => runWithGh(bin),
      /github token required: set GITHUB_TOKEN or run gh auth login/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
