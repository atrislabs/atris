const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ax = require('../ax');

test('ax routes workspace questions to local Atris 2 tools', () => {
  assert.equal(ax.resolveRoute('what files are here?'), 'local');
  assert.equal(ax.resolveRoute('search src for the input component'), 'local');
  assert.equal(ax.resolveRoute('fix the xp game tests'), 'local');

  const payload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: '/tmp/project',
  });

  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, '/tmp/project');
  assert.equal(payload.max_turns, 8);
});

test('ax routes connector reads to authenticated cloud context', () => {
  assert.equal(ax.resolveRoute('what is on my calendar today?'), 'cloud');
  assert.equal(ax.resolveRoute('which integrations are connected?'), 'cloud');

  const payload = ax.buildPayload('what is on my calendar today?', {
    mode: 'fast',
    cwd: '/tmp/project',
    connectionContext: {
      schema: 'atris.connection_capabilities.v1',
      connections: [],
    },
  });

  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.max_turns, 1);
  assert.equal(payload.connection_context.schema, 'atris.connection_capabilities.v1');
});

test('ax carries local connector lookup id only on cloud payloads', () => {
  const localPayload = ax.buildPayload('what files are here?', {
    route: 'local',
    cwd: '/tmp/project',
    connectionUserId: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(localPayload.connection_user_id, undefined);

  const cloudPayload = ax.buildPayload('what is on my calendar today?', {
    route: 'cloud',
    connectionUserId: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(cloudPayload.connection_user_id, '00000000-0000-4000-8000-000000000001');
});

test('ax can force local or cloud routing', () => {
  assert.equal(ax.resolveRoute('what files are here?', { route: 'cloud' }), 'cloud');
  assert.equal(ax.resolveRoute('what is on my calendar?', { route: 'local' }), 'local');
  assert.equal(ax.buildPayload('what is on my calendar?', { route: 'local', cwd: '/tmp/project' }).workspace_path, '/tmp/project');
  assert.equal(ax.buildPayload('what files are here?', { route: 'cloud', cwd: '/tmp/project' }).workspace_path, undefined);
});

test('ax backend URL is configurable', () => {
  const previous = process.env.AX_BACKEND_URL;
  process.env.AX_BACKEND_URL = 'http://127.0.0.1:9001';
  try {
    assert.equal(ax.backendUrl(), 'http://127.0.0.1:9001/api/atris2/turn');
  } finally {
    if (previous === undefined) delete process.env.AX_BACKEND_URL;
    else process.env.AX_BACKEND_URL = previous;
  }
});

test('ax formats paths with filename emphasis spacing', () => {
  const formatted = ax.formatPathSubject(path.join('/tmp', 'project', 'src', 'App.tsx'), { color: false });
  assert.equal(formatted, '/tmp/project/src/  App.tsx');
});
