const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// commands/social destructures apiRequestJson when required, so the fake
// handler must be in place before requiring ../commands/social.
const apiModule = require('../utils/api');
const realApiRequestJson = apiModule.apiRequestJson;

let respond = () => {
  throw new Error('unexpected API call');
};
const calls = [];
apiModule.apiRequestJson = async (pathname, options = {}) => {
  calls.push({ pathname, options });
  return respond(pathname, options);
};

const { inviteCommand } = require('../commands/social');

const savedEnv = {};
const savedArgv = process.argv;
let savedStdinIsTTY;
let savedStdoutIsTTY;
let tmpRoot;

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

async function run(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  process.exit = (code) => {
    throw new ExitSignal(code === undefined ? 0 : code);
  };
  let exitCode = null;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    exitCode = e.code;
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }
  return { exitCode, out: out.join('\n'), err: err.join('\n') };
}

before(() => {
  savedStdinIsTTY = process.stdin.isTTY;
  savedStdoutIsTTY = process.stdout.isTTY;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ATRIS_') || k === 'HOME') {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-social-invite-test-'));
  process.env.HOME = tmpRoot;
  process.env.ATRIS_TOKEN = 'test-token';
  process.env.ATRIS_APP_URL = 'https://app.example.test';
  process.env.ATRIS_AGENT_TOKEN_FILE = path.join(tmpRoot, 'no-agent-token.json');
});

after(() => {
  apiModule.apiRequestJson = realApiRequestJson;
  process.argv = savedArgv;
  process.stdin.isTTY = savedStdinIsTTY;
  process.stdout.isTTY = savedStdoutIsTTY;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ATRIS_') || k === 'HOME') {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  process.argv = savedArgv;
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  process.env.ATRIS_TOKEN = 'test-token';
  respond = () => {
    throw new Error('unexpected API call');
  };
});

test('inviteCommand creates a plain invite carrying a pack slug (normal input)', async () => {
  process.argv = ['node', 'atris', 'invite', '--pack', 'starter'];
  respond = (pathname, options) => {
    if (pathname === '/invites' && options.method === 'POST') {
      return {
        status: 200,
        data: {
          invite_code: 'CODE-PACK-1',
          share_url: 'https://app.example.test/invite/CODE-PACK-1',
        },
      };
    }
    throw new Error(`unexpected call ${pathname}`);
  };

  const r = await run(() => inviteCommand());
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathname, '/invites');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.body, {
    resource_type: 'atris_plain',
    pre_config: { metadata: { pack_slug: 'starter' } },
  });
  assert.match(r.out, /Invite link \(share it with anyone\):/);
  assert.match(r.out, /https:\/\/app\.example\.test\/invite\/CODE-PACK-1/);
  assert.match(r.out, /Comes with the "starter" pack\. In a terminal they run: atris join CODE-PACK-1/);
});

test('inviteCommand creates a personalized invite with target metadata and locked email (normal input)', async () => {
  process.argv = [
    'node', 'atris', 'invite',
    '--for', 'Grace Hopper',
    '--email', 'grace@example.com',
    '--company', 'Navy Computing',
    '--role', 'Admiral',
    '--why', 'Compilers discussion',
    '--use', 'Automated code review',
    '--days', '30',
  ];

  respond = (pathname, options) => {
    if (pathname === '/agent/my-agents') {
      return {
        status: 200,
        data: {
          my_agents: [
            { id: 'agent-navy-1', name: 'Compiler Bot' },
          ],
        },
      };
    }
    if (pathname === '/invites/personalize' && options.method === 'POST') {
      return {
        status: 200,
        data: {
          invite_code: 'GRACE-42',
          share_url: 'https://app.example.test/invite/GRACE-42',
          email_subject: 'Invitation to collaborate on compilers',
          email_body: 'Hi Grace,\nLooking forward to working together.',
        },
      };
    }
    throw new Error(`unexpected call ${pathname}`);
  };

  const r = await run(() => inviteCommand());
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].pathname, '/agent/my-agents');
  assert.strictEqual(calls[1].pathname, '/invites/personalize');

  const sentBody = calls[1].options.body;
  assert.strictEqual(sentBody.source_agent_id, 'agent-navy-1');
  assert.strictEqual(sentBody.target_name, 'Grace Hopper');
  assert.strictEqual(sentBody.target_email, 'grace@example.com');
  assert.strictEqual(sentBody.target_company, 'Navy Computing');
  assert.strictEqual(sentBody.target_role, 'Admiral');
  assert.strictEqual(sentBody.target_context, 'Compilers discussion');
  assert.strictEqual(sentBody.use_case, 'Automated code review');
  assert.strictEqual(sentBody.restrict_to_email, true);
  assert.strictEqual(sentBody.expires_days, 30);

  assert.match(r.out, /Building a personalized invite \(cloning "Compiler Bot"\)\.\.\./);
  assert.match(r.out, /Invite for Grace Hopper/);
  assert.match(r.out, /https:\/\/app\.example\.test\/invite\/GRACE-42/);
  assert.match(r.out, /Subject: Invitation to collaborate on compilers/);
  assert.match(r.out, /Hi Grace,/);
  assert.match(r.out, /Locked to grace@example\.com\. They must sign up with that address\./);
  assert.match(r.out, /Terminal path for them: atris join GRACE-42/);
});

test('inviteCommand with --help exits with code 2 and prints usage (edge case)', async () => {
  process.argv = ['node', 'atris', 'invite', '--help'];

  const r = await run(() => inviteCommand());
  assert.strictEqual(r.exitCode, 2);
  assert.strictEqual(calls.length, 0);
  assert.match(r.out, /^atris social, people, friends, and messages on Atris/);
  assert.match(r.out, /atris invite\s+Guided personalized invite/);
  assert.match(r.out, /atris invite --pack <slug>/);
});

test('inviteCommand with empty arguments in non-interactive environment creates a plain link (empty case)', async () => {
  process.argv = ['node', 'atris', 'invite'];
  respond = (pathname, options) => {
    if (pathname === '/invites' && options.method === 'POST') {
      return {
        status: 200,
        data: {
          invite_code: 'PLAIN-EMPTY',
          share_url: 'https://app.example.test/invite/PLAIN-EMPTY',
        },
      };
    }
    throw new Error(`unexpected call ${pathname}`);
  };

  const r = await run(() => inviteCommand());
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].options.body, { resource_type: 'atris_plain' });
  assert.match(r.out, /https:\/\/app\.example\.test\/invite\/PLAIN-EMPTY/);
  assert.match(r.out, /When they sign up through it, find them with: atris people <their name>/);
});

test('inviteCommand exits with error when not logged in (error case)', async () => {
  delete process.env.ATRIS_TOKEN;
  process.argv = ['node', 'atris', 'invite', '--pack', 'starter'];

  const r = await run(() => inviteCommand());
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(r.err, 'Not logged in. Run: atris login');
});

test('inviteCommand reports error when personalized invite finds no agents (error case)', async () => {
  process.argv = ['node', 'atris', 'invite', '--for', 'Ada'];
  respond = (pathname) => {
    if (pathname === '/agent/my-agents') {
      return { status: 200, data: { my_agents: [] } };
    }
    throw new Error(`unexpected call ${pathname}`);
  };

  const r = await run(() => inviteCommand());
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(calls.length, 1);
  assert.match(r.err, /You have no agents to clone for a personalized invite\./);
});

test('inviteCommand handles API failure response (error case)', async () => {
  process.argv = ['node', 'atris', 'invite', '--pack', 'demo'];
  respond = () => ({
    status: 500,
    data: { detail: 'Database connection failed' },
  });

  const r = await run(() => inviteCommand());
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(r.err, 'Database connection failed');
});
