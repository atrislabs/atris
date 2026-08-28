const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  gmailTriageVerdict,
  parseGmailTriageArgs,
} = require('../commands/integrations');

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
      loadCredentials: () => ({ token: 'test-token', email: 'owner@example.com' }),
      ensureValidCredentials: async () => ({
        credentials: { token: 'test-token', email: 'owner@example.com' },
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
      if (originals.auth) require.cache[authPath] = originals.auth;
      else delete require.cache[authPath];
      if (originals.api) require.cache[apiPath] = originals.api;
      else delete require.cache[apiPath];
      if (originals.integrations) require.cache[integrationsPath] = originals.integrations;
      else delete require.cache[integrationsPath];
    },
  };
}

test('gmail triage rules archive broadcasts and keep personal mail', () => {
  assert.equal(gmailTriageVerdict({ from: 'News <noreply@updates.example>' }), 'archive');
  assert.equal(gmailTriageVerdict({ from: 'Maya <maya@example.com>' }), 'keep');
  assert.deepEqual(gmailTriageVerdict({ from: 'News <noreply@updates.example>' }, { details: true }), {
    verdict: 'archive',
    reason: 'noreply sender',
  });
  assert.deepEqual(gmailTriageVerdict({ from: 'Digest <daily@mail.sendgrid.net>' }, { details: true }), {
    verdict: 'archive',
    reason: 'bulk mail domain',
  });
  assert.deepEqual(gmailTriageVerdict({
    from: 'Editor <editor@example.com>',
    headers: [{ name: 'List-Unsubscribe', value: '<https://example.com/unsubscribe>' }],
  }, { details: true }), {
    verdict: 'archive',
    reason: 'list or unsubscribe headers',
  });
  assert.deepEqual(gmailTriageVerdict({ from: 'Maya <maya@example.com>' }, { details: true }), {
    verdict: 'keep',
    reason: 'personal sender',
  });
  assert.deepEqual(parseGmailTriageArgs([]), { accountId: null, limit: 25 });
  assert.deepEqual(parseGmailTriageArgs(['--limit', '7', '--account', 'work']), {
    accountId: 'work',
    limit: 7,
  });
});

test('gmail triage records keep and archive verdicts without mutating the mailbox', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-triage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = [
    {
      id: 'broadcast-1',
      from: 'Product News <no-reply@updates.example>',
      subject: 'weekly product news',
    },
    {
      message_id: 'personal-1',
      sender: 'Maya <maya@example.com>',
      subject: 'dinner this week?',
    },
  ];
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    if (pathname === '/integrations/gmail/accounts') {
      return { ok: true, status: 200, data: [] };
    }
    if (pathname === '/integrations/gmail/messages?max_results=2&account_id=work') {
      return { ok: true, status: 200, data: { messages: fixtures } };
    }
    throw new Error(`unexpected gmail request: ${pathname}`);
  });
  const output = [];
  const originalLog = console.log;
  console.log = (line) => output.push(String(line));

  try {
    await integrations.gmailTriage({ accountId: 'work', limit: 2, root });
    await integrations.gmailTriage({ accountId: 'work', limit: 2, root });
  } finally {
    console.log = originalLog;
    restore();
  }

  const verdictPath = integrations.gmailVerdictsPath(root);
  const rows = fs.readFileSync(verdictPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => /^\d{4}-\d{2}-\d{2}T/.test(row.ts)));
  assert.deepEqual(rows.map(({ ts, ...row }) => row), [
    {
      account: 'work',
      verdict: 'archive',
      reason: 'noreply sender',
      message_id: 'broadcast-1',
      from: 'Product News <no-reply@updates.example>',
      subject: 'weekly product news',
    },
    {
      account: 'work',
      verdict: 'keep',
      reason: 'personal sender',
      message_id: 'personal-1',
      from: 'Maya <maya@example.com>',
      subject: 'dinner this week?',
    },
  ]);
  assert.deepEqual(output, [
    'gmail triage recorded 1 keep and 1 archive verdicts.',
    'gmail triage recorded 0 keep and 0 archive verdicts (2 already judged).',
  ]);
  assert.deepEqual(calls.map((call) => call.pathname), [
    '/integrations/gmail/accounts',
    '/integrations/gmail/messages?max_results=2&account_id=work',
    '/integrations/gmail/accounts',
    '/integrations/gmail/messages?max_results=2&account_id=work',
  ]);
  assert.ok(calls.every((call) => call.options.method === 'GET'));
  assert.equal(calls.some((call) => call.pathname.includes('archive')), false);
});
