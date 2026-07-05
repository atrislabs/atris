const test = require('node:test');
const assert = require('node:assert/strict');

const ax = require('../ax');

function captureOutput() {
  let text = '';
  return {
    isTTY: false,
    write(chunk) {
      text += String(chunk || '');
      return true;
    },
    text() {
      return text;
    },
  };
}

function toolDeps({ apiResponse, approval } = {}) {
  const calls = [];
  const approvals = [];
  const output = captureOutput();
  return {
    output,
    calls,
    approvals,
    loadCredentials: () => ({ token: 'stored-token' }),
    getApiBaseUrl: () => 'https://api.atris.ai/api',
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return apiResponse || { ok: true, status: 200, data: { ok: true, service: 'ready' }, text: '{"ok":true}' };
    },
    approveBackendApi: async (request) => {
      approvals.push(request);
      return approval;
    },
  };
}

test('backend_api get runs without approval', async () => {
  const deps = toolDeps();
  const result = await ax.executeBackendApiTool(
    { method: 'get', endpoint: '/api/atris2/health' },
    deps
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.endpoint, '/api/atris2/health');
  assert.equal(deps.approvals.length, 0);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].pathname, '/atris2/health');
  assert.equal(deps.calls[0].options.method, 'GET');
  assert.equal(deps.calls[0].options.token, 'stored-token');
  assert.doesNotMatch(deps.output.text(), /approve backend_api/);
});

test('backend_api post requires explicit approval before firing', async () => {
  const denied = toolDeps({ approval: 'ok' });
  const deniedResult = await ax.executeBackendApiTool(
    { method: 'post', endpoint: '/api/improve', payload: { mode: 'plan', workspace: '/tmp/demo' } },
    denied
  );

  assert.equal(deniedResult.status, 'error');
  assert.match(deniedResult.error, /was not approved/);
  assert.equal(denied.calls.length, 0);
  assert.equal(denied.approvals.length, 1);
  assert.match(denied.output.text(), /approve backend_api post \/api\/improve payload \{"mode":"plan","workspace":"\/tmp\/demo"\}\? yes\/no:/);

  const approved = toolDeps({
    approval: 'yes',
    apiResponse: { ok: true, status: 202, data: { accepted: true }, text: '{"accepted":true}' },
  });
  const approvedResult = await ax.executeBackendApiTool(
    { method: 'post', endpoint: '/api/improve', payload: { mode: 'plan' } },
    approved
  );

  assert.equal(approvedResult.status, 'ok');
  assert.equal(approved.calls.length, 1);
  assert.equal(approved.calls[0].pathname, '/improve');
  assert.equal(approved.calls[0].options.method, 'POST');
  assert.deepEqual(approved.calls[0].options.body, { mode: 'plan' });
  assert.equal(approvedResult.receipt, 'backend_api post /api/improve status 202: {"accepted":true}');
});

test('backend_api refuses non-allowlisted endpoints', async () => {
  const deps = toolDeps();
  const result = await ax.executeBackendApiTool(
    { method: 'get', endpoint: '/api/admin/secrets' },
    deps
  );

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'backend_api refused: get /api/admin/secrets is not allowlisted');
  assert.equal(deps.calls.length, 0);
  assert.equal(deps.approvals.length, 0);
});

test('backend_api receipt line includes endpoint, status code, and 120-char summary', () => {
  const summary = 'a'.repeat(130);
  const receipt = ax.formatBackendApiReceipt({
    method: 'GET',
    endpoint: '/api/atris2/health',
    status: 200,
    summary,
  });

  assert.equal(
    receipt,
    `backend_api get /api/atris2/health status 200: ${'a'.repeat(117)}...`
  );
});
