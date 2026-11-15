const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../utils/api');
const computer = require('../commands/computer');

test('a cloud run survives six failed polls and completes', async () => {
  let calls = 0;
  const request = async () => ++calls <= 6
    ? { ok: false }
    : { ok: true, data: { status: 'completed', events: [{ type: 'assistant_text', content: 'done' }, { type: 'complete' }] } };
  const original = api.apiRequestJson;
  api.apiRequestJson = request;
  try {
    const result = await computer.streamBusinessChatResult('token', { businessId: 'b', workspaceId: 'w' }, 'run', null, {
      quiet: true, sleep: async () => {}, apiRequestJson: request, write: () => {}, writeError: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 7);
  } finally {
    api.apiRequestJson = original;
  }
});
