'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const apiModule = require('../utils/api');
const authModule = require('../utils/auth');

const realApiRequestJson = apiModule.apiRequestJson;
const realEnsureValidCredentials = authModule.ensureValidCredentials;

let apiHandler = null;
let authHandler = null;

apiModule.apiRequestJson = async (...args) => {
  if (apiHandler) {
    return apiHandler(...args);
  }
  throw new Error(`Unexpected apiRequestJson call: ${JSON.stringify(args[0])}`);
};

authModule.ensureValidCredentials = async (...args) => {
  if (authHandler) {
    return authHandler(...args);
  }
  return {
    credentials: {
      token: 'mock-token',
      user_id: 'usr-default',
      email: 'builder@example.com',
    },
  };
};

const { feedCommand } = require('../commands/feed');

function setupTestEnv(t) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-cmd-test-'));
  const origEnv = { ...process.env };
  const origCwd = process.cwd();
  const origLog = console.log;
  const origError = console.error;

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  process.env.HOME = tmpHome;

  const logs = [];
  const errors = [];

  console.log = (...args) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
  };

  t.after(() => {
    console.log = origLog;
    console.error = origError;
    process.chdir(origCwd);

    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(origEnv)) {
      process.env[key] = val;
    }

    apiHandler = null;
    authHandler = null;

    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch (_) {}
  });

  return { tmpHome, logs, errors };
}

function bindBusiness(dir, { businessId = 'biz_123', name = 'Acme Corp', slug = 'acme-corp' } = {}) {
  const dotAtris = path.join(dir, '.atris');
  fs.mkdirSync(dotAtris, { recursive: true });
  fs.writeFileSync(
    path.join(dotAtris, 'business.json'),
    JSON.stringify({ business_id: businessId, name, slug }, null, 2),
    'utf8'
  );
}

test('feedCommand prints usage and returns 0 when --help is passed', async (t) => {
  const { logs } = setupTestEnv(t);

  const code = await feedCommand(['--help']);

  assert.strictEqual(code, 0);
  const out = logs.join('\n');
  assert.ok(out.includes('Usage: atris feed'));
  assert.ok(out.includes('atris feed post "<content>"'));
});

test('feedCommand returns 1 and error message when no business binding exists', async (t) => {
  const { tmpHome, errors } = setupTestEnv(t);
  process.chdir(tmpHome);

  const code = await feedCommand(['list']);

  assert.strictEqual(code, 1);
  const err = errors.join('\n');
  assert.ok(err.includes('No .atris/business.json found above this directory'));
});

test('feedCommand returns 1 and error message when auth check fails', async (t) => {
  const { tmpHome, errors } = setupTestEnv(t);
  bindBusiness(tmpHome);
  process.chdir(tmpHome);

  authHandler = async () => ({ error: 'not_logged_in' });

  const code = await feedCommand(['list']);

  assert.strictEqual(code, 1);
  const err = errors.join('\n');
  assert.ok(err.includes('Not logged in (not_logged_in)'));
});

test('feedCommand list fetches and displays feed posts for normal input', async (t) => {
  const { tmpHome, logs } = setupTestEnv(t);
  bindBusiness(tmpHome, { businessId: 'biz_sample', name: 'Sample Co' });
  process.chdir(tmpHome);

  const apiCalls = [];
  apiHandler = async (pathname, options) => {
    apiCalls.push({ pathname, options });
    return {
      status: 200,
      data: {
        posts: [
          {
            id: 'post_001',
            author_display_name: 'Alice Developer',
            created_at: '2026-04-12T10:15:00.000Z',
            content: 'Shipped verification gates',
          },
        ],
      },
    };
  };

  const code = await feedCommand(['list']);

  assert.strictEqual(code, 0);
  assert.strictEqual(apiCalls.length, 1);
  assert.ok(apiCalls[0].pathname.startsWith('/business/biz_sample/feed'));
  assert.strictEqual(apiCalls[0].options.token, 'mock-token');

  const out = logs.join('\n');
  assert.ok(out.includes('[2026-04-12 10:15] Alice Developer: Shipped verification gates'));
});

test('feedCommand list outputs JSON when --json flag is provided', async (t) => {
  const { tmpHome, logs } = setupTestEnv(t);
  bindBusiness(tmpHome, { businessId: 'biz_sample' });
  process.chdir(tmpHome);

  apiHandler = async () => ({
    status: 200,
    data: {
      posts: [
        {
          id: 'post_002',
          author_display_name: 'Bob Architect',
          post_type: 'agent_post',
          agent_name: 'ArchitectBot',
          created_at: '2026-04-12T11:00:00.000Z',
          content: 'Cleaned up stale projection records',
        },
      ],
    },
  });

  const code = await feedCommand(['list', '--json']);

  assert.strictEqual(code, 0);
  const parsed = JSON.parse(logs.join('\n'));
  assert.strictEqual(Array.isArray(parsed), true);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].id, 'post_002');
  assert.strictEqual(parsed[0].author, 'ArchitectBot');
  assert.strictEqual(parsed[0].content, 'Cleaned up stale projection records');
  assert.strictEqual(parsed[0].created_at, '2026-04-12T11:00:00.000Z');
});

test('feedCommand list logs friendly message on empty feed edge case', async (t) => {
  const { tmpHome, logs } = setupTestEnv(t);
  bindBusiness(tmpHome, { businessId: 'biz_sample' });
  process.chdir(tmpHome);

  apiHandler = async () => ({
    status: 200,
    data: {
      posts: [],
    },
  });

  const code = await feedCommand(['list']);

  assert.strictEqual(code, 0);
  const out = logs.join('\n');
  assert.ok(out.includes('No posts matched.'));
});

test('feedCommand post publishes message and reports success', async (t) => {
  const { tmpHome, logs } = setupTestEnv(t);
  bindBusiness(tmpHome, { businessId: 'biz_sample', name: 'Sample Co' });
  process.chdir(tmpHome);

  let postedBody = null;
  apiHandler = async (pathname, options) => {
    if (options.method === 'POST') {
      postedBody = options.body;
      return {
        status: 200,
        data: { id: 'post_new_77' },
      };
    }
    throw new Error('Expected POST request');
  };

  const code = await feedCommand(['post', 'completed', 'autonomous', 'pass']);

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(postedBody, { content: 'completed autonomous pass' });
  const out = logs.join('\n');
  assert.ok(out.includes('✓ Posted to Sample Co feed (post_new_77)'));
});

test('feedCommand post returns 1 and error when content is empty', async (t) => {
  const { tmpHome, errors } = setupTestEnv(t);
  bindBusiness(tmpHome, { businessId: 'biz_sample' });
  process.chdir(tmpHome);

  const code = await feedCommand(['post', '   ']);

  assert.strictEqual(code, 1);
  const err = errors.join('\n');
  assert.ok(err.includes('Nothing to post. Usage: atris feed post "<content>"'));
});

test('feedCommand returns 1 and error on unknown subcommand', async (t) => {
  const { tmpHome, errors } = setupTestEnv(t);
  bindBusiness(tmpHome, { businessId: 'biz_sample' });
  process.chdir(tmpHome);

  const code = await feedCommand(['invalid-action']);

  assert.strictEqual(code, 1);
  const err = errors.join('\n');
  assert.ok(err.includes('Unknown subcommand: invalid-action'));
});
