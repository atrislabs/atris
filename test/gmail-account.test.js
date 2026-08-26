const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  extractGmailMailboxAccount,
  parseGmailArgs,
  gmailAccountStatePath,
} = require('../commands/integrations');

const SAMPLE_ACCOUNTS = [
  { account_id: 'default', email_address: 'Me@Example.com', display_name: 'Work Inbox' },
  { account_id: 'personal', email_address: 'home@example.com', display_name: 'Personal' },
  { account_id: 'research', email_address: 'keshav@research.com', display_name: 'Research' },
];

function withMockedIntegrations(apiRequestJson, { stickyAccountId = null } = {}) {
  const authPath = require.resolve('../utils/auth');
  const apiPath = require.resolve('../utils/api');
  const integrationsPath = require.resolve('../commands/integrations');
  const originals = {
    auth: require.cache[authPath],
    api: require.cache[apiPath],
    integrations: require.cache[integrationsPath],
    gmailAccountFile: process.env.ATRIS_GMAIL_ACCOUNT_FILE,
  };

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gmail-account-'));
  const gmailAccountFile = path.join(homeDir, 'gmail-account.json');
  process.env.ATRIS_GMAIL_ACCOUNT_FILE = gmailAccountFile;
  if (stickyAccountId) {
    fs.mkdirSync(path.dirname(gmailAccountFile), { recursive: true });
    fs.writeFileSync(gmailAccountFile, `${JSON.stringify({ account_id: stickyAccountId }, null, 2)}\n`, 'utf8');
  }

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
    gmailAccountFile,
    homeDir,
    restore() {
      if (originals.auth) require.cache[authPath] = originals.auth; else delete require.cache[authPath];
      if (originals.api) require.cache[apiPath] = originals.api; else delete require.cache[apiPath];
      if (originals.integrations) require.cache[integrationsPath] = originals.integrations; else delete require.cache[integrationsPath];
      if (originals.gmailAccountFile === undefined) delete process.env.ATRIS_GMAIL_ACCOUNT_FILE;
      else process.env.ATRIS_GMAIL_ACCOUNT_FILE = originals.gmailAccountFile;
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function accountsApi(apiRequestJson, accounts = SAMPLE_ACCOUNTS) {
  return async (pathname, options) => {
    if (pathname === '/integrations/gmail/accounts') {
      return { ok: true, status: 200, data: accounts };
    }
    return apiRequestJson(pathname, options);
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

test('gmailAccountStatePath honors ATRIS_GMAIL_ACCOUNT_FILE', () => {
  const previous = process.env.ATRIS_GMAIL_ACCOUNT_FILE;
  process.env.ATRIS_GMAIL_ACCOUNT_FILE = '/tmp/custom-gmail-account.json';
  try {
    assert.equal(gmailAccountStatePath(), '/tmp/custom-gmail-account.json');
  } finally {
    if (previous === undefined) delete process.env.ATRIS_GMAIL_ACCOUNT_FILE;
    else process.env.ATRIS_GMAIL_ACCOUNT_FILE = previous;
  }
});

test('gmail inbox without --account uses default account_id when no sticky account', async () => {
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
  assert.equal(calls[0].pathname, '/integrations/gmail/messages?max_results=10&account_id=default');
});

test('gmail inbox uses sticky account when flag absent', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: true, status: 200, data: { messages: [] } };
  }, { stickyAccountId: 'personal' });
  const originalLog = console.log;
  console.log = () => {};
  try {
    await integrations.gmailCommand('inbox');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/integrations/gmail/messages?max_results=10&account_id=personal');
});

test('gmail inbox with --account overrides sticky account', async () => {
  const calls = [];
  const { integrations, restore } = withMockedIntegrations(async (pathname, options) => {
    calls.push({ pathname, options });
    return { ok: true, status: 200, data: { messages: [] } };
  }, { stickyAccountId: 'personal' });
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

test('gmail archive without --account uses default account_id', async () => {
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
  assert.deepEqual(calls[0].options.body, { message_ids: ['msg-1'], account_id: 'default' });
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

test('gmail accounts marks the active account and keeps lowercase output', async () => {
  const { integrations, restore } = withMockedIntegrations(accountsApi(async () => ({ ok: true, status: 200, data: [] })));
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
    'me@example.com, work inbox (active)',
    'home@example.com, personal',
    'keshav@research.com, research',
  ]);
});

test('gmail use with no arg prints the current sticky account', async () => {
  const { integrations, restore } = withMockedIntegrations(
    accountsApi(async () => ({ ok: true, status: 200, data: [] })),
    { stickyAccountId: 'research' },
  );
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await integrations.gmailCommand('use');
  } finally {
    console.log = originalLog;
    restore();
  }

  assert.deepEqual(lines, ['using research (keshav@research.com)']);
});

test('gmail use persists a valid account and prints confirmation', async () => {
  const { integrations, gmailAccountFile, restore } = withMockedIntegrations(
    accountsApi(async () => ({ ok: true, status: 200, data: [] })),
  );
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await integrations.gmailCommand('use', 'research');
    assert.deepEqual(lines, ['now using research (keshav@research.com)']);
    assert.deepEqual(JSON.parse(fs.readFileSync(gmailAccountFile, 'utf8')), { account_id: 'research' });
  } finally {
    console.log = originalLog;
    restore();
  }
});

test('gmail use rejects unknown ids and lists available accounts', async () => {
  const { integrations, restore } = withMockedIntegrations(
    accountsApi(async () => ({ ok: true, status: 200, data: [] })),
  );
  const errors = [];
  const originalError = console.error;
  const originalExit = process.exit;
  console.error = (line) => errors.push(String(line));
  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  try {
    await assert.rejects(
      () => integrations.gmailCommand('use', 'missing'),
      /exit:1/,
    );
  } finally {
    console.error = originalError;
    process.exit = originalExit;
    restore();
  }

  assert.deepEqual(errors, [
    'unknown gmail account "missing".',
    'connected accounts:',
    '  default: me@example.com, work inbox',
    '  personal: home@example.com, personal',
    '  research: keshav@research.com, research',
  ]);
});
