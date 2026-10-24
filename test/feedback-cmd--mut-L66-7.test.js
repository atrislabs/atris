'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('submission keeps the selected business scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-business-triage-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const businessId = '12345678-1234-1234-1234-123456789abc';
  let requestBody;
  const previousArgv = process.argv;
  const previousToken = process.env.ATRIS_TOKEN;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const originalRequest = api.apiRequestJson;
  try {
    process.env.HOME = root;
    process.chdir(root);
    api.apiRequestJson = async (pathname, options) => {
      requestBody = options.body;
      return { ok: true, status: 200, statusCode: 200, data: { feedback_id: 'feed-12345678' } };
    };
    process.env.ATRIS_TOKEN = 'fixture-token';
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    process.argv = [process.execPath, 'atris', 'feedback', 'submit', 'The queue shows resolved reports.', '--business', businessId];
    const { feedbackCommand } = require('../commands/feedback');
    await feedbackCommand();
    assert.equal(requestBody.business_id, businessId);
  } finally {
    process.argv = previousArgv;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    if (previousToken === undefined) delete process.env.ATRIS_TOKEN;
    else process.env.ATRIS_TOKEN = previousToken;
    api.apiRequestJson = originalRequest;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
