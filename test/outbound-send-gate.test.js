const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-send-gate-'));
}

function runCli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cwd || repoRoot,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
}

function withMockedIntegrations(apiRequestJson) {
  const authPath = require.resolve('../utils/auth');
  const apiPath = require.resolve('../utils/api');
  const integrationsPath = require.resolve('../commands/integrations');
  const originals = {
    auth: require.cache[authPath],
    api: require.cache[apiPath],
    integrations: require.cache[integrationsPath],
  };

  delete require.cache[integrationsPath];
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      loadCredentials: () => ({ token: 'test-token', email: 'sender@example.com' }),
      ensureValidCredentials: async () => ({
        credentials: { token: 'test-token', email: 'sender@example.com' },
      }),
    },
  };
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: { apiRequestJson },
  };

  const integrations = require('../commands/integrations');
  return {
    integrations,
    restore() {
      if (originals.auth) require.cache[authPath] = originals.auth; else delete require.cache[authPath];
      if (originals.api) require.cache[apiPath] = originals.api; else delete require.cache[apiPath];
      if (originals.integrations) require.cache[integrationsPath] = originals.integrations; else delete require.cache[integrationsPath];
    },
  };
}

test('slack send blocks html body files without render proof before auth', () => {
  const dir = makeTempDir();
  try {
    const htmlFile = path.join(dir, 'raw-update.html');
    fs.writeFileSync(htmlFile, '<html><body><h1>customer update</h1></body></html>\n', 'utf8');
    const res = runCli(['slack', 'send', 'C123', '--format', 'html', '--body-file', htmlFile]);
    const stderr = res.stderr.trim();
    assert.equal(res.status, 1, res.stdout || res.stderr);
    assert.equal(stderr.split('\n').length, 1);
    assert.match(stderr, /outbound artifact gate failed: render-proof-missing in /);
    assert.match(stderr, /raw-update\.html$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plain slack sends pass through unchanged to the mocked api call', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: true, status: 200, data: { ok: true } };
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await integrations.slackSend('C123', ['plain', 'customer', 'update']);
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/integrations/slack/me/send');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.token, 'test-token');
  assert.deepEqual(calls[0].options.body, {
    channel: 'C123',
    text: 'plain customer update',
  });
});
