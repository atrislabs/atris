'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { runCiRunner } = require('../lib/ci-runner');

test('rejects an HTTP location on a status 300 runner download', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ci-redirect-'));
  const previousStateDir = process.env.ATRIS_TEST_STATE_DIR;
  process.env.ATRIS_TEST_STATE_DIR = home;
  t.mock.method(os, 'homedir', () => home);
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.ATRIS_TEST_STATE_DIR;
    else process.env.ATRIS_TEST_STATE_DIR = previousStateDir;
    fs.rmSync(home, { recursive: true, force: true });
  });

  let requests = 0;
  t.mock.method(https, 'get', (_url, _options, callback) => {
    requests += 1;
    assert.equal(requests, 1, 'must reject before requesting the insecure location');
    const request = new EventEmitter();
    const response = new EventEmitter();
    response.statusCode = 300;
    response.headers = { location: 'http://runner.invalid/archive.tar.gz' };
    response.resume = () => {};
    queueMicrotask(() => callback(response));
    return request;
  });

  await assert.rejects(runCiRunner({
    repos: [{ owner: 'owner', repo: 'repo', slug: 'owner/repo' }],
    once: true,
  }, {
    resolveGithubToken: () => 'test-token',
    log: () => {},
  }), {
    name: 'Error',
    message: 'runner download redirected outside https',
  });
  assert.equal(requests, 1);
});
