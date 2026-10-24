'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-bad-request-'));
const originalHome = process.env.HOME;
process.env.HOME = home;

const api = require('../utils/api');
const originalRequest = api.apiRequestJson;
api.apiRequestJson = async () => ({
  status: 400,
  data: { detail: 'Invalid feed request' },
});
const { fetchPosts } = require('../commands/feed');

test.after(() => {
  api.apiRequestJson = originalRequest;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

test('a bad request rejects instead of appearing to be an empty feed', async () => {
  await assert.rejects(
    () => fetchPosts('biz-example', 'example-token', 5),
    /\b400\b/,
  );
});
