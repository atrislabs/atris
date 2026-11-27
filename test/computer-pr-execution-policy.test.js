'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePrArgs } = require('../lib/computer-pr');
const { computerPr } = require('../commands/computer');

test('subscription and turn flags parse without entering the task text', () => {
  const parsed = parsePrArgs(['owner/repo', 'fix description', '--require-subscription', '--max-turns=3']);
  assert.equal(parsed.task, 'fix description');
  assert.equal(parsed.requireSubscription, true);
  assert.equal(parsed.maxTurns, 3);
  assert.equal(parsePrArgs(['owner/repo', 'fix', '--max-turns', '100']).maxTurns, 100);
});

test('invalid turn limits are rejected before dispatch', () => {
  for (const value of ['', '0', '101', '-1', '2.5', 'three', '3junk', 'Infinity']) {
    assert.throws(() => parsePrArgs(['owner/repo', 'fix', `--max-turns=${value}`]), /whole number/);
  }
  assert.throws(() => parsePrArgs(['owner/repo', 'fix', '--max-turns']), /whole number/);
});

async function attemptedRound(flags) {
  const calls = [];
  const oldExitCode = process.exitCode;
  try {
    const result = await computerPr('fake', ['owner/repo', 'fix description', '--no-feed', '--no-think', ...flags],
      { businessId: 'business', workspaceId: 'workspace' }, {}, {
        log() {}, logError() {}, write() {}, cloudTeam: null,
        ensureBusinessAwake: async () => true,
        apiRequestJson: async (path, options) => {
          if (path.endsWith('/execution-policy')) return { ok: true, data: { version: 1, require_subscription: true } };
          calls.push({ path, options });
          return { ok: false, status: 409, data: { detail: 'A linked subscription is required.' } };
        },
        streamBusinessChatResult: async () => { throw new Error('must not stream rejected work'); },
      });
    assert.equal(result, 1);
    return calls;
  } finally { process.exitCode = oldExitCode; }
}

test('real command forwards explicit policy and does not retry a subscription rejection', async () => {
  const calls = await attemptedRound(['--require-subscription', '--max-turns', '3']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/business/business/chat/subscription-only');
  assert.equal(calls[0].options.body.require_subscription, true);
  assert.equal(calls[0].options.body.max_turns, 3);
  assert.equal(calls[0].options.retries, 0);
});

test('legacy command does not add execution policy fields', async () => {
  const calls = await attemptedRound([]);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].options.body, 'require_subscription'), false);
  assert.equal(Object.hasOwn(calls[0].options.body, 'max_turns'), false);
});

test('outer option parser preserves both flags for the pr parser', () => {
  const { parseComputerOptions } = require('../commands/computer');
  const parsed = parseComputerOptions(['pr', 'owner/repo', 'fix', '--business', 'example', '--require-subscription', '--max-turns', '2']);
  const values = parsePrArgs(parsed.positional.slice(1));
  assert.equal(values.maxTurns, 2);
  assert.equal(values.requireSubscription, true);
});

test('thinker and builder requests both receive explicit limits', async () => {
  const calls = [];
  const oldExitCode = process.exitCode;
  try {
    await computerPr('fake', ['owner/repo', 'fix', '--no-feed', '--think', '--thinker', 'test-model', '--require-subscription', '--max-turns=2'],
      { businessId: 'business', workspaceId: 'workspace' }, {}, {
        log() {}, logError() {}, write() {}, cloudTeam: null,
        ensureBusinessAwake: async () => true,
        apiRequestJson: async (path, options) => {
          if (path.endsWith('/execution-policy')) return { ok: true, data: { version: 1, require_subscription: true } };
          calls.push(options.body);
          return { ok: true, data: { execution_id: `run-${calls.length}` } };
        },
        streamBusinessChatResult: async () => ({ ok: true, status: 'completed', text: 'no fix found' }),
      });
    assert.equal(calls.length, 2);
    for (const body of calls) {
      assert.equal(body.require_subscription, true);
      assert.equal(body.max_turns, 2);
    }
  } finally { process.exitCode = oldExitCode; }
});


test('missing or malformed capability refuses before wake or dispatch', async () => {
  for (const reply of [{ ok: false, status: 404 }, { ok: true, data: {} },
    { ok: true, data: { version: 1, require_subscription: "true" } },
    { ok: true, data: { version: 2, require_subscription: true } }]) {
    const calls = [];
    const oldExitCode = process.exitCode;
    try {
      const result = await computerPr('fake', ['owner/repo', 'fix', '--require-subscription'],
        { businessId: 'business', workspaceId: 'workspace' }, {}, {
          log() {}, logError() {}, cloudTeam: null,
          ensureBusinessAwake: async () => { throw new Error('must not wake'); },
          apiRequestJson: async (path, options) => { calls.push({ path, options }); return reply; },
        });
      assert.equal(result, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, '/business/business/chat/execution-policy');
      assert.equal(calls[0].options.method, 'GET');
      assert.equal(calls[0].options.token, 'fake');
    } finally { process.exitCode = oldExitCode; }
  }
});


test('mixed rollout dispatch404 never falls back to legacy chat', async () => {
  const calls = [];
  const oldExitCode = process.exitCode;
  try {
    const result = await computerPr('fake', ['owner/repo', 'fix', '--require-subscription', '--no-feed'],
      { businessId: 'business', workspaceId: 'workspace' }, {}, {
        log() {}, logError() {}, cloudTeam: null,
        ensureBusinessAwake: async () => true,
        apiRequestJson: async (path, options) => {
          calls.push({ path, options });
          return options.method === 'GET' ? { ok: true, data: { version: 1, require_subscription: true } } : { ok: false, status: 404 };
        },
      });
    assert.equal(result, 1);
    assert.deepEqual(calls.map(c => c.path), ['/business/business/chat/execution-policy', '/business/business/chat/subscription-only']);
  } finally { process.exitCode = oldExitCode; }
});
