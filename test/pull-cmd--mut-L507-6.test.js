'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('a snapshot server error reports the server failure rather than a timeout', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pull-failure-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const request = api.apiRequestJson;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  const stopped = new Error('command exited');
  try {
    process.env.HOME = folder;
    process.chdir(folder);
    fs.mkdirSync('atris');
    fs.mkdirSync('.atris');
    fs.writeFileSync('.atris/credentials.json', JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync('.atris/business.json', JSON.stringify({
      business_id: 'biz-test', workspace_id: 'workspace-test', slug: 'sample',
    }));
    api.apiRequestJson = async (endpoint) => {
      if (endpoint === '/business/') {
        return { ok: true, data: [{
          id: 'biz-test', workspace_id: 'workspace-test', slug: 'sample', name: 'Sample',
        }] };
      }
      return { ok: false, status: 503, error: 'service unavailable' };
    };
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = () => { throw stopped; };
    const { pullAtris } = require('../commands/pull');
    try {
      await pullAtris();
    } catch (caught) {
      if (caught !== stopped) throw caught;
    }
    assert.equal(output.some(line => line.includes('service unavailable')), true);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    api.apiRequestJson = request;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
