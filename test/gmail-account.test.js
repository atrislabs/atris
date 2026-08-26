const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractGmailMailboxAccount,
  parseGmailArgs,
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

test('extractGmailMailboxAccount pulls mailbox id before account gate handling', () => {
  assert.deepEqual(extractGmailMailboxAccount(['inbox', '--account', 'work']), {
    args: ['inbox'],
    mailboxAccountId: 'work',
  });
  assert.deepEqual(extractGmailMailboxAccount(['inbox', '--account']), {
    args: ['inbox', '--account'],
    mailboxAccountId: null,
  });
});

test('parseGmailArgs splits account flag from positional ids', () => {
  assert.deepEqual(parseGmailArgs(['msg-1', 'msg-2', '--account', 'personal']), {
    accountId: 'personal',
    positional: ['msg-1', 'msg-2'],
  });
});

test('gmail inbox without --account keeps the legacy request path', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: true, status: 200, data: { messages: [] } };
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await integrations.gmailCommand('inbox');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/integrations/gmail/messages?max_results=10');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.token, 'test-token');
});

test('gmail inbox with --account adds account_id query param', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: true, status: 200, data: { messages: [] } };
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await integrations.gmailCommand('inbox', '--account', 'work');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/integrations/gmail/messages?max_results=10&account_id=work');
});

test('gmail read with --account adds account_id query param', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return {
      ok: true,
      status: 200,
      data: { from: 'a@example.com', to: 'b@example.com', subject: 'hi', body: 'hello' },
    };
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await integrations.gmailCommand('read', 'msg-42', '--account', 'work');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/integrations/gmail/messages/msg-42?account_id=work');
});

test('gmail archive without --account keeps legacy json body', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: true, status: 200, data: { archived: 1 } };
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await integrations.gmailCommand('archive', 'msg-1');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/integrations/gmail/messages/batch-archive');
  assert.deepEqual(calls[0].options.body, { message_ids: ['msg-1'] });
});

test('gmail archive with --account adds account_id to json body', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: true, status: 200, data: { archived: 2 } };
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await integrations.gmailCommand('archive', 'msg-1', 'msg-2', '--account', 'work');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.body, {
    message_ids: ['msg-1', 'msg-2'],
    account_id: 'work',
  });
});

test('gmail accounts renders one lowercase line per connected account', async () => {
  const { integrations, restore } = withMockedIntegrations(async (pathname) => {
    assert.equal(pathname, '/integrations/gmail/accounts');
    return {
      ok: true,
      status: 200,
      data: [
        { account_id: 'default', email_address: 'Me@Example.com', display_name: 'Work Inbox' },
        { account_id: 'personal', email_address: 'home@example.com', display_name: 'Personal' },
      ],
    };
  });
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await integrations.gmailCommand('accounts');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.deepEqual(lines, [
    'me@example.com, work inbox',
    'home@example.com, personal',
  ]);
});
