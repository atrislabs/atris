const test = require('node:test');
const assert = require('node:assert/strict');
const { agentClientCommand } = require('../commands/agent-client');

test('listing rejects a non-object payload returned by a response getter', async () => {
  const output = [];
  const errors = [];
  const payload = Object.assign(() => {}, {
    clients: [{ client_id: 'atc_example', name: 'example' }],
  });
  let reads = 0;
  const response = {
    ok: true,
    status: 200,
    // The first two reads pass the command's response normalization.
    // The third supplies the value that its list formatter must validate.
    get data() { return ++reads <= 2 ? {} : payload; },
  };
  const code = await agentClientCommand(['list', '--json'], {
    log: (line) => output.push(line),
    err: (line) => errors.push(line),
    readActiveCredentials: () => null,
    ensureValidCredentials: async () => ({ credentials: { token: 'test-token' } }),
    apiRequestJson: async () => response,
  });

  assert.deepEqual(output, ['{"ok":true,"clients":[]}']);
  assert.deepEqual(errors, []);
  assert.equal(code, 0);
});
