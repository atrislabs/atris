'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { agentHomeCommand, isHomeCommand } = require('../commands/agent-home');
const home = require('../lib/agent-home');

const response = { agent_id: 'agent/1', api_model: 'designer-1', api_lane: 'atris:design', api_skills: 'full', api_library: true, granted: false, serving: false };

async function run(args, options = {}) {
  const calls = [];
  const output = [];
  const errors = [];
  const code = await agentHomeCommand(args, {
    token: 'test-secret', cwd: options.cwd || os.tmpdir(), env: options.env || {},
    log: (line) => output.push(line), err: (line) => errors.push(line),
    apiRequestJson: async (route, request) => {
      calls.push({ route, ...request });
      return options.answer ? options.answer(route, request) : { ok: true, data: response };
    },
  });
  return { code, calls, output, errors };
}

test('publish sends the model settings and optional price, and reports waiting', async () => {
  const result = await run(['publish', 'agent/1', '--as', 'designer-1', '--lane', 'atris:design', '--full-skills', '--library', '--price', '0.5']);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [
    { route: '/agent/agent%2F1/publish', method: 'POST', body: { api_model: 'designer-1', api_lane: 'atris:design', api_skills: 'full', api_library: true }, token: 'test-secret' },
    { route: '/agent-wallet/agent%2F1/price', method: 'POST', body: { price_usdc: 0.5 }, token: 'test-secret' },
  ]);
  assert.deepEqual(result.output, ['published agent/1 as designer-1.', 'price: $0.50 a call.', 'live: no.', 'waiting for Atris to switch the name on.']);
});

test('price is optional, accepts the boundaries, and rejects invalid values before any request', async () => {
  const noPrice = await run(['publish', 'agent/1', '--as', 'designer-1']);
  assert.equal(noPrice.calls.length, 1);
  assert.deepEqual(noPrice.calls[0].body, { api_model: 'designer-1' });
  assert.equal(noPrice.output[1], 'price: unchanged.');
  for (const price of ['0', '1000']) {
    const result = await run(['publish', 'agent/1', '--as', 'designer-1', '--price', price]);
    assert.equal(result.code, 0);
    assert.equal(result.calls[1].body.price_usdc, Number(price));
  }
  for (const price of ['-0.01', '1000.01', 'NaN', 'Infinity']) {
    const result = await run(['publish', 'agent/1', '--as', 'designer-1', '--price', price]);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.match(result.errors[0], /0 to 1000/);
  }
});

test('unpublish uses delete and json returns the server answer without keys', async () => {
  const answer = { ...response, api_model: null, private_key: 'never-print-this' };
  const result = await run(['unpublish', 'agent/1', '--json'], { answer: () => ({ ok: true, data: answer }) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [{ route: '/agent/agent%2F1/publish', method: 'DELETE', token: 'test-secret' }]);
  assert.deepEqual(JSON.parse(result.output[0]), { ...response, api_model: null });
  assert.doesNotMatch(result.output[0], /never-print-this|test-secret/);
  const published = await run(['publish', 'agent/1', '--as', 'designer-1', '--json']);
  assert.deepEqual(JSON.parse(published.output[0]), response);
});

test('missing model name fails with usage and no request', async () => {
  const result = await run(['publish', 'agent/1']);
  assert.equal(result.code, 1);
  assert.match(result.errors[0], /usage: atris agent publish.*--as/);
  assert.equal(result.calls.length, 0);
});

test('saved names and pulled folders resolve to the agent id', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir };
  home.writeKeyFile('designer', { agent_id: 'saved-id', private_key: 'do-not-print' }, env);
  const named = await run(['publish', 'designer', '--as', 'designer-1'], { cwd: dir, env });
  assert.equal(named.calls[0].route, '/agent/saved-id/publish');
  assert.doesNotMatch(named.output.join('\n'), /do-not-print/);
  home.saveState(dir, { agent_id: 'folder-id', handle: 'designer', files: {} });
  const folder = await run(['unpublish'], { cwd: dir, env });
  assert.equal(folder.calls[0].route, '/agent/folder-id/publish');
});

test('price failure reports that publishing already happened', async () => {
  const result = await run(['publish', 'agent/1', '--as', 'designer-1', '--price', '1'], {
    answer: (route) => route.includes('agent-wallet') ? { ok: false, status: 500 } : { ok: true, data: response },
  });
  assert.equal(result.code, 1);
  assert.match(result.errors[0], /published agent\/1, but could not set the price/);
});

test('both verbs reach the home command and show help through the real cli', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-publish-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const verb of ['publish', 'unpublish']) {
    assert.equal(isHomeCommand([verb]), true);
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'agent', verb, '--help'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /atris agent publish/);
    assert.match(result.stdout, /atris agent unpublish/);
  }
});
