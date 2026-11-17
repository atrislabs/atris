'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('single dispatch option skips preflight renewal and401 replay in real API function', async () => {
  let renewalCalls = 0, requests = 0;
  const source = fs.readFileSync(path.join(__dirname, '../utils/api.js'), 'utf8');
  const context = {
    require: name => name === './agent-client' ? {
      freshTokenFor: async () => { renewalCalls++; return 'fresh'; },
      tokenAfterUnauthorized: async () => { renewalCalls++; return 'refreshed'; },
    } : require(name),
    __dirname: path.join(__dirname, '../utils'), module: { exports: {} },
    process, Buffer, URL, setTimeout, clearTimeout, console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.fakeHttp = async () => { requests++; return { status: 401, body: Buffer.from('{}') }; };
  vm.runInContext('httpRequest = fakeHttp', context);
  const result = await context.module.exports.apiRequestJson('/business/example/chat/subscription-only', {
    method: 'POST', token: 'fake', retries: 0, noAuthRenewal: true, timeoutMs: 100,
  });
  assert.equal(result.status, 401);
  assert.equal(requests, 1);
  assert.equal(renewalCalls, 0);
  requests = 0;
  await context.module.exports.apiRequestJson('/example', { token: 'fake', retries: 0 });
  assert.equal(requests, 2);
  assert.equal(renewalCalls, 3);
});
