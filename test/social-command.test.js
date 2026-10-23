const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The module destructures apiRequestJson when it loads, so the fake server has
// to be in place before the first require of commands/social.
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

const {
  socialCommand,
  peopleCommand,
  friendsCommand,
  joinCommand,
} = require('../commands/social');

const ENV_KEYS = [
  'HOME', 'ATRIS_TOKEN', 'ATRIS_CLIENT_ID', 'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE', 'ATRIS_APP_URL',
];
const savedEnv = {};
const savedArgv = process.argv;
let tmpRoot;

const ADA = { id: '11111111-1111-4111-8111-111111111111', name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com' };
const ADAM = { id: '22222222-2222-4222-8222-222222222222', name: 'Adam Smith', username: 'adam', email: 'adam@example.com' };

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// Runs fn with console and process.exit captured. exitCode stays null when the
// command returns without exiting.
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

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-social-test-'));
  process.env.HOME = tmpRoot;
  process.env.ATRIS_TOKEN = 'test-token';
  process.env.ATRIS_APP_URL = 'https://app.example.test';
  process.env.ATRIS_AGENT_TOKEN_FILE = path.join(tmpRoot, 'no-agent-token.json');
  delete process.env.ATRIS_CLIENT_ID;
  delete process.env.ATRIS_PROFILE;
});

after(() => {
  apiModule.apiRequestJson = realApiRequestJson;
  process.argv = savedArgv;
  for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  process.argv = savedArgv;
  setEnv('ATRIS_TOKEN', 'test-token');
  respond = () => {
    throw new Error('unexpected API call');
  };
});

test('help, --help and -h print the command list and exit cleanly without calling the API', async () => {
  for (const flag of ['help', '--help', '-h']) {
    const r = await run(() => socialCommand([flag]));
    assert.strictEqual(r.exitCode, null, flag);
    assert.match(r.out, /^atris social, people, friends, and messages on Atris/, flag);
    assert.match(r.out, /atris follow <who>\s+Add a friend \(follow\)/, flag);
    assert.match(r.out, /atris join <code\|link>\s+Accept an invite/, flag);
    assert.strictEqual(r.err, '', flag);
  }
  assert.strictEqual(calls.length, 0);
});

test('an unknown subcommand prints help and exits 1', async () => {
  const r = await run(() => socialCommand(['bogus']));
  assert.strictEqual(r.exitCode, 1);
  assert.match(r.out, /atris inbox\s+All conversations/);
  assert.strictEqual(calls.length, 0);
});

test('commands that need an argument print a usage line and exit 2 before touching the API', async () => {
  const cases = [
    [['people'], 'Usage: atris people <name or email>'],
    [['find', '--help'], 'Usage: atris people <name or email>'],
    [['follow'], 'Usage: atris follow <who>'],
    [['unfollow'], 'Usage: atris unfollow <who>'],
    [['msg'], 'Usage: atris msg <who> [message]'],
    [['msg', 'ada', '-h'], 'Usage: atris msg <who> [message]'],
    [['friends', '--help'], 'Usage: atris friends [followers|following]'],
    [['inbox', 'help'], 'Usage: atris inbox'],
    [['join', '--help'], 'Usage: atris join <invite-code or invite link> [--handle <yourhandle>]'],
  ];
  for (const [args, usage] of cases) {
    const r = await run(() => socialCommand(args));
    assert.strictEqual(r.exitCode, 2, args.join(' '));
    assert.strictEqual(r.err, usage, args.join(' '));
  }
  assert.strictEqual(calls.length, 0);
});

test('invite --help prints the full help text and exits 2', async () => {
  const r = await run(() => socialCommand(['invite', '--help']));
  assert.strictEqual(r.exitCode, 2);
  assert.match(r.out, /atris invite --pack <slug>\s+Plain link that also installs a pack on claim/);
  assert.strictEqual(calls.length, 0);
});

test('join with no code exits 1 with usage, and top-level aliases read argv for help', async () => {
  const noCode = await run(() => socialCommand(['join']));
  assert.strictEqual(noCode.exitCode, 1);
  assert.match(noCode.err, /Usage: atris join <invite-code or invite link>/);

  process.argv = ['node', 'atris', 'people', '--help'];
  const people = await run(() => peopleCommand());
  assert.strictEqual(people.exitCode, 2);
  assert.strictEqual(people.err, 'Usage: atris people <name or email>');

  process.argv = ['node', 'atris', 'join', 'ABC', '--help'];
  const join = await run(() => joinCommand());
  assert.strictEqual(join.exitCode, 2);
  assert.match(join.err, /^Usage: atris join/);
  assert.strictEqual(calls.length, 0);
});

test('without a login the command exits 1 and tells the user to log in', async () => {
  delete process.env.ATRIS_TOKEN;
  const r = await run(() => socialCommand(['inbox']));
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.err, 'Not logged in. Run: atris login');
  assert.strictEqual(calls.length, 0);
});

test('a 401 from the server says the session expired', async () => {
  respond = () => ({ status: 401, data: {} });
  const r = await run(() => socialCommand(['inbox']));
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.err, 'Session expired. Run: atris login');
});

test('people searches with an encoded query and the token, and renders each person', async () => {
  respond = () => ({
    status: 200,
    data: [
      { ...ADA, is_mutual: true, bio: 'First programmer' },
      { ...ADAM, is_following: true },
      { id: '33333333-3333-4333-8333-333333333333', email: 'quiet@example.com' },
    ],
  });
  const r = await run(() => socialCommand(['people', 'ada', 'lovelace']));
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathname, '/social/search?q=ada%20lovelace');
  assert.strictEqual(calls[0].options.token, 'test-token');
  assert.deepStrictEqual(r.out.split('\n'), [
    'Found 3:',
    '  Ada Lovelace (@ada)  · friends',
    '      First programmer',
    '  Adam Smith (@adam)  · following',
    '  quiet@example.com',
  ]);
});

test('people with no matches points at invite', async () => {
  respond = () => ({ status: 200, data: [] });
  const r = await run(() => socialCommand(['people', 'nobody']));
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(r.out, 'No one found for "nobody". Invite them: atris invite');
});

test('follow strips @, prefers the exact username match, and reports a mutual follow', async () => {
  respond = (pathname) => {
    if (pathname.startsWith('/social/search')) return { status: 200, data: [ADAM, ADA] };
    if (pathname === `/social/follow/${ADA.id}`) return { status: 200, data: {} };
    if (pathname === `/social/check/${ADA.id}`) return { status: 200, data: { is_mutual: true } };
    throw new Error(`unexpected ${pathname}`);
  };
  const r = await run(() => socialCommand(['follow', '@ada']));
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls[0].pathname, '/social/search?q=ada');
  assert.strictEqual(calls[1].pathname, `/social/follow/${ADA.id}`);
  assert.strictEqual(calls[1].options.method, 'POST');
  assert.strictEqual(r.out, 'You and Ada Lovelace (@ada) are now friends (you follow each other).');
});

test('follow says "Now following" when the other side has not followed back', async () => {
  respond = (pathname) => {
    if (pathname.startsWith('/social/search')) return { status: 200, data: [ADA] };
    if (pathname.startsWith('/social/follow/')) return { status: 200, data: {} };
    return { status: 200, data: { is_mutual: false } };
  };
  const r = await run(() => socialCommand(['add', 'ada']));
  assert.strictEqual(r.out, "Now following Ada Lovelace (@ada). When they follow back, you're friends.");
});

test('follow with a UUID skips the search, and unfollow uses DELETE', async () => {
  respond = () => ({ status: 200, data: {} });
  const r = await run(() => socialCommand(['unfollow', ADA.id]));
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathname, `/social/follow/${ADA.id}`);
  assert.strictEqual(calls[0].options.method, 'DELETE');
  assert.strictEqual(r.out, `Unfollowed ${ADA.id}.`);
});

test('follow refuses to guess when several people match', async () => {
  respond = () => ({ status: 200, data: [ADA, ADAM] });
  const r = await run(() => socialCommand(['follow', 'ad']));
  assert.strictEqual(r.exitCode, 1);
  assert.match(r.err, /"ad" matches 2 people:/);
  assert.match(r.err, /Ada Lovelace \(@ada\)/);
  assert.match(r.err, /Adam Smith \(@adam\)/);
  assert.match(r.err, /Be more specific \(use the @username\)\./);
  assert.strictEqual(calls.length, 1, 'only the search ran, no follow request');
});

test('follow with no match exits 1 and suggests people', async () => {
  respond = () => ({ status: 200, data: [] });
  const r = await run(() => socialCommand(['follow', 'ghost']));
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.err, 'No one found matching "ghost". Try: atris people <name>');
});

test('friends picks the endpoint from its argument and labels the list', async () => {
  const cases = [
    [[], '/social/mutuals', 'Friends (1):'],
    [['followers'], '/social/followers', 'Followers (1):'],
    [['following'], '/social/following', 'Following (1):'],
  ];
  for (const [extra, endpoint, heading] of cases) {
    calls.length = 0;
    respond = () => ({ status: 200, data: [ADA] });
    const r = await run(() => socialCommand(['friends', ...extra]));
    assert.strictEqual(calls[0].pathname, endpoint);
    assert.strictEqual(r.out.split('\n')[0], heading);
    assert.match(r.out, /Ada Lovelace \(@ada\)/);
  }
});

test('friends shows a hint when the list is empty, and the alias reads argv', async () => {
  respond = () => ({ status: 200, data: [] });
  const none = await run(() => socialCommand(['friends']));
  assert.strictEqual(none.out, 'No friends yet. Find people: atris people <name> · Invite: atris invite');

  process.argv = ['node', 'atris', 'friends', 'followers'];
  calls.length = 0;
  const followers = await run(() => friendsCommand());
  assert.strictEqual(calls[0].pathname, '/social/followers');
  assert.strictEqual(followers.out, 'Followers: none yet.');
});

test('inbox lists unread conversations first and trims long previews', async () => {
  respond = () => ({
    status: 200,
    data: {
      conversations: [
        { other_user: { name: 'Quiet Quinn' }, unread_count: 0, last_message_preview: 'ok' },
        { other_user: ADA, unread_count: 3, last_message_preview: 'x'.repeat(120) },
      ],
    },
  });
  const r = await run(() => socialCommand(['inbox']));
  const lines = r.out.split('\n');
  assert.strictEqual(lines[0], 'Conversations (2):');
  assert.strictEqual(lines[2], '  Ada Lovelace (@ada)  · 3 unread');
  assert.strictEqual(lines[3], `      ${'x'.repeat(80)}`);
  assert.strictEqual(lines[4], '  Quiet Quinn');
  assert.strictEqual(lines[lines.length - 1], 'Read one: atris msg <who>');
});

test('msg with text opens the conversation and sends the message body', async () => {
  respond = (pathname, options) => {
    if (pathname === '/dm/conversations') return { status: 200, data: { id: 'conv-1', other_user: ADA } };
    if (pathname === '/dm/conversations/conv-1/messages') return { status: 200, data: {} };
    throw new Error(`unexpected ${pathname} ${options.method}`);
  };
  const r = await run(() => socialCommand(['msg', ADA.id, 'hello', 'there']));
  assert.strictEqual(r.out, 'Sent to Ada Lovelace (@ada).');
  assert.deepStrictEqual(calls[0].options.body, { user_id: ADA.id });
  assert.strictEqual(calls[1].options.method, 'POST');
  assert.deepStrictEqual(calls[1].options.body, { content: 'hello there', content_type: 'text' });
});

test('msg without text prints the conversation and marks it read', async () => {
  respond = (pathname) => {
    if (pathname === '/dm/conversations') return { status: 200, data: { id: 'conv-1', other_user: ADA } };
    if (pathname.startsWith('/dm/conversations/conv-1/messages')) {
      return {
        status: 200,
        data: {
          messages: [
            { content: 'hi ada', is_mine: true, created_at: '2026-01-02T03:04:05Z' },
            { content: 'hello back', is_mine: false, created_at: '2026-01-02T03:05:05Z' },
          ],
        },
      };
    }
    return { status: 200, data: {} };
  };
  const r = await run(() => socialCommand(['msg', ADA.id]));
  assert.match(r.out, /^Conversation with Ada Lovelace \(@ada\):/);
  assert.match(r.out, /\n {2}you · .+\n {2}hi ada\n/);
  assert.match(r.out, /\n {2}Ada Lovelace \(@ada\) · .+\n {2}hello back\n/);
  assert.strictEqual(calls[1].pathname, '/dm/conversations/conv-1/messages?limit=30');
  const last = calls[calls.length - 1];
  assert.strictEqual(last.pathname, '/dm/conversations/conv-1/read');
  assert.strictEqual(last.options.method, 'POST');
});

test('social with no subcommand prints the overview from three endpoints', async () => {
  respond = (pathname) => {
    if (pathname === '/social/stats') return { status: 200, data: { followers_count: 7, following_count: 4, mutuals_count: 2 } };
    if (pathname === '/dm/unread') return { status: 200, data: { total_unread: 5 } };
    if (pathname === '/social/suggested?limit=5') return { status: 200, data: [ADAM] };
    throw new Error(`unexpected ${pathname}`);
  };
  const r = await run(() => socialCommand([]));
  assert.strictEqual(r.exitCode, null);
  const lines = r.out.split('\n');
  assert.strictEqual(lines[0], 'Followers 7 · Following 4 · Friends 2');
  assert.strictEqual(lines[1], 'Unread messages: 5  → atris inbox');
  assert.match(r.out, /People you may know:\n {2}Adam Smith \(@adam\)/);
  assert.match(r.out, /Add one: atris follow <name>/);
  assert.match(r.out, /Invite a friend: atris invite$/);
  assert.deepStrictEqual(calls.map((c) => c.pathname).sort(), ['/dm/unread', '/social/stats', '/social/suggested?limit=5']);
});

test('invite --pack makes a plain link carrying the pack', async () => {
  respond = () => ({ status: 200, data: { invite_code: 'ZX81', share_url: 'https://app.example.test/invite/ZX81' } });
  const r = await run(() => socialCommand(['invite', '--pack', 'growth']));
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathname, '/invites');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.body, {
    resource_type: 'atris_plain',
    pre_config: { metadata: { pack_slug: 'growth' } },
  });
  assert.match(r.out, /https:\/\/app\.example\.test\/invite\/ZX81/);
  assert.match(r.out, /Comes with the "growth" pack\. In a terminal they run: atris join ZX81/);
});

test('personalized invite builds the body from flags, clamps days, and locks to the email', async () => {
  respond = (pathname) => {
    if (pathname === '/agent/my-agents') return { status: 200, data: { my_agents: [{ id: 'agent-1', name: 'Front Desk' }] } };
    if (pathname === '/invites/personalize') {
      return {
        status: 200,
        data: {
          share_url: 'https://app.example.test/invite/PERS1',
          invite_code: 'PERS1',
          email_subject: 'A gift',
          email_body: 'line one\nline two',
        },
      };
    }
    throw new Error(`unexpected ${pathname}`);
  };
  const r = await run(() => socialCommand([
    'invite', '--for', 'Grace', '--email', 'grace@example.com', '--company', 'Hopper HVAC',
    '--days', '200', '--pack', 'growth',
  ]));
  assert.strictEqual(r.exitCode, null);
  const body = calls[1].options.body;
  assert.strictEqual(body.source_agent_id, 'agent-1');
  assert.strictEqual(body.target_name, 'Grace');
  assert.strictEqual(body.target_email, 'grace@example.com');
  assert.strictEqual(body.target_company, 'Hopper HVAC');
  assert.strictEqual(body.restrict_to_email, true);
  assert.strictEqual(body.expires_days, 90);
  assert.strictEqual(body.pack_slug, 'growth');
  assert.match(r.out, /Building a personalized invite \(cloning "Front Desk"\)/);
  assert.match(r.out, /Subject: A gift/);
  assert.match(r.out, /\n {2}line one\n {2}line two\n/);
  assert.match(r.out, /Locked to grace@example\.com\. They must sign up with that address\./);
  assert.match(r.out, /Terminal path for them: atris join PERS1/);
});

test('personalized invite with --any-email is not locked, and a 402 asks for a paid plan', async () => {
  respond = (pathname) => {
    if (pathname === '/agent/my-agents') return { status: 200, data: { my_agents: [{ id: 'a', name: 'A' }] } };
    return { status: 402, data: {} };
  };
  const r = await run(() => socialCommand(['invite', '--for', 'Grace', '--any-email']));
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.err, 'Personalized invites need a paid plan.');
  assert.strictEqual(calls[1].options.body.restrict_to_email, false);
  assert.strictEqual(calls[1].options.body.expires_days, 14);
});

test('personalized invite with no agents exits 1 instead of calling the server', async () => {
  respond = () => ({ status: 200, data: { my_agents: [] } });
  const r = await run(() => socialCommand(['invite', '--for', 'Grace']));
  assert.strictEqual(r.exitCode, 1);
  assert.match(r.err, /You have no agents to clone/);
  assert.strictEqual(calls.length, 1);
});

test('join cleans a pasted link to an upper-case code and claims it with an idempotency key', async () => {
  respond = (pathname, options) => {
    if (pathname === '/invites/ABC123') {
      return { status: 200, data: { inviter_display_name: 'Ada', can_claim: true } };
    }
    if (pathname === '/invites/ABC123/claim') return { status: 200, data: { status: 'claimed' } };
    throw new Error(`unexpected ${pathname} ${options.method}`);
  };
  const r = await run(() => socialCommand(['join', 'https://app.example.test/invite/abc123']));
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls[0].pathname, '/invites/ABC123');
  assert.strictEqual(calls[1].pathname, '/invites/ABC123/claim');
  assert.strictEqual(calls[1].options.method, 'POST');
  assert.match(calls[1].options.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.match(r.out, /^Invite from Ada/);
  assert.match(r.out, /You're in\. Connected through Ada's invite\./);
  assert.match(r.out, /atris people <name>\s+find your inviter and follow back/);
});

test('join reports a missing invite and an invite with no claims left', async () => {
  respond = () => ({ status: 404, data: {} });
  const missing = await run(() => socialCommand(['join', 'nope']));
  assert.strictEqual(missing.exitCode, 1);
  assert.strictEqual(missing.err, 'That invite does not exist or has expired.');

  respond = () => ({ status: 200, data: { can_claim: false } });
  const spent = await run(() => socialCommand(['join', 'USED']));
  assert.strictEqual(spent.exitCode, 1);
  assert.strictEqual(spent.err, 'This invite has no claims left.');
  assert.match(spent.out, /^Invite from someone on Atris/);
});

test('join without an account and without --handle prints the browser-free next step', async () => {
  delete process.env.ATRIS_TOKEN;
  respond = () => ({ status: 200, data: { inviter_display_name: 'Ada', can_claim: true } });
  const stdinTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  let r;
  try {
    r = await run(() => socialCommand(['join', 'abc123']));
  } finally {
    process.stdin.isTTY = stdinTty;
  }
  assert.strictEqual(r.exitCode, null);
  assert.strictEqual(calls.length, 1, 'only the public preview ran, no claim');
  assert.match(r.out, /atris join ABC123 --handle <yourhandle>/);
  assert.match(r.out, /Or sign up in a browser: https:\/\/app\.example\.test\/invite\/ABC123/);
});
