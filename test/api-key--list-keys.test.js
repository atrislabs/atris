'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { listKeys } = require('../commands/api-key');

test('listKeys formats wrapped keys in order with exact spacing', () => {
  assert.strictEqual(listKeys({ keys: [
    { id: 'key-1', name: 'build', api_key: 'ak_first' },
    { id: 'key-2', name: 'deploy', api_key_prefix: 'ak_second' },
    { id: 'key-3', name: 'local' },
  ] }), 'key-1  build  ak_first\nkey-2  deploy  ak_second\nkey-3  local');
});

test('listKeys accepts a bare array and falls back to legacy fields and labels', () => {
  assert.strictEqual(listKeys([
    { agent_id: 'agent-1', label: 'legacy', api_key_prefix: 'ak_legacy' },
    { agent_id: 'agent-2', agent_name: 'worker' },
    { id: 'key-3' },
    {},
  ]), 'agent-1  legacy  ak_legacy\nagent-2  worker\nkey-3  api key\n  api key');
});

test('listKeys prefers primary fields over legacy aliases', () => {
  assert.strictEqual(listKeys({ keys: [{
    id: 'primary', agent_id: 'legacy',
    name: 'chosen', label: 'alternate', agent_name: 'old',
    api_key: 'ak_primary', api_key_prefix: 'ak_alternate',
  }] }), 'primary  chosen  ak_primary');
  assert.strictEqual(listKeys([{ id: '', name: '', api_key: '',
    agent_id: 'fallback', label: 'backup', api_key_prefix: 'ak_backup',
  }]), 'fallback  backup  ak_backup');
});

test('listKeys returns the empty message for missing, empty, or unsupported input', () => {
  assert.strictEqual(listKeys(), 'no api keys yet.');
  for (const input of [null, {}, [], { keys: [] }, { keys: {} },
    { keys: 'invalid' }, 'invalid', 0, false]) {
    assert.strictEqual(listKeys(input), 'no api keys yet.');
  }
});
