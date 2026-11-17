'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { newsletterCommand, PERSON_ONLY } = require('../commands/newsletter');
const { knownCommands } = require('../lib/known-commands');

const NL = 'nl-1';

// A stand-in for the backend's /api/newsletters routes.
function fakeServer({ newsletters = [{ id: NL, name: 'Field Notes', postal_address: '1 Main St, Town, ST 00000' }], sendStatus = 200 } = {}) {
  const state = { calls: [], bodies: [] };
  const request = async (pathname, options = {}) => {
    assert.equal(options.token, 'tok', 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    const method = options.method || 'GET';
    state.calls.push(`${method} ${url.pathname}${url.search}`);
    state.bodies.push(options.body);
    if (url.pathname === '/newsletters') return { ok: true, status: 200, data: { newsletters } };
    if (url.pathname === `/newsletters/${NL}/readers/bulk`) {
      return { ok: true, status: 200, data: { added: 2, already_on_list: 1, repeated_in_paste: 0, invalid: 0 } };
    }
    if (url.pathname === `/newsletters/${NL}/readers`) {
      return { ok: true, status: 200, data: { readers: [{ email: 'a@x.com', status: 'active', confirmed: true }], total: 1 } };
    }
    if (url.pathname === `/newsletters/${NL}/issues`) return { ok: true, status: 200, data: { id: 'is-1', title: options.body.title } };
    if (url.pathname === `/newsletters/${NL}/issues/is-1/preview`) {
      return { ok: true, status: 200, data: { subject: 'Week one', from: 'letters@atrismail.com', text: 'Hello\nUnsubscribe: https://u', html: '<p>Hello</p>', problems: [] } };
    }
    if (url.pathname === `/newsletters/${NL}/issues/is-1/send`) {
      if (options.body.dry_run) {
        return { ok: true, status: 200, data: { dry_run: true, would_send: 1, readers: [{ email: 'a@x.com' }], problems: [], message: 'Nothing was sent. Pressing send now would reach 1 reader.' } };
      }
      if (sendStatus === 403) return { ok: false, status: 403, data: { detail: 'Only a signed-in person can send an issue.' } };
      return { ok: true, status: 200, data: { dry_run: false, sent_now: 1, message: 'Sent to 1 reader.' } };
    }
    throw new Error(`unexpected call ${method} ${pathname}`);
  };
  return { state, request };
}

async function run(args, server = fakeServer(), extra = {}) {
  const out = [];
  const errs = [];
  const code = await newsletterCommand(args, {
    log: (line) => out.push(String(line)),
    err: (line) => errs.push(String(line)),
    getToken: async () => ({ token: 'tok' }),
    apiRequestJson: server.request,
    ...extra,
  });
  return { code, out: out.join('\n'), err: errs.join('\n'), server };
}

test('registered as a known command', () => {
  assert.ok(knownCommands.includes('newsletter'));
});

test('help lists every subcommand and needs no login', async () => {
  const lines = [];
  const code = await newsletterCommand(['help'], { log: (l) => lines.push(l), getToken: async () => { throw new Error('no login'); } });
  assert.equal(code, 0);
  const text = lines.join('\n');
  for (const words of ['readers add', 'readers list', 'issue new', 'issue preview', 'send <issue> --dry-run']) {
    assert.ok(text.includes(words), words);
  }
});

test('not logged in says so', async () => {
  const { code, err } = await run(['list'], fakeServer(), { getToken: async () => ({ token: '' }) });
  assert.equal(code, 1);
  assert.match(err, /atris login/);
});

test('readers add needs --permission and sends pasted addresses', async () => {
  const refused = await run(['readers', 'add', 'a@x.com']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--permission/);
  assert.deepEqual(refused.server.state.calls, []);

  const { code, out, server } = await run(['readers', 'add', 'a@x.com', 'b@x.com', '--permission']);
  assert.equal(code, 0);
  assert.equal(out, 'Added 2. 1 already on the list.');
  assert.deepEqual(server.state.calls, ['GET /newsletters', `POST /newsletters/${NL}/readers/bulk`]);
  assert.deepEqual(server.state.bodies[1], { text: 'a@x.com\nb@x.com', permission: true });
});

test('readers add reads a file', async () => {
  const { code, server } = await run(['readers', 'add', '--file', 'r.csv', '--permission', '--newsletter', NL], fakeServer(),
    { readFile: () => 'email,name\nc@x.com,Cara\n' });
  assert.equal(code, 0);
  assert.equal(server.state.calls[0], `POST /newsletters/${NL}/readers/bulk`, '--newsletter skips the lookup');
  assert.match(server.state.bodies[0].text, /c@x.com,Cara/);
});

test('readers list prints each reader and the total', async () => {
  const { code, out, server } = await run(['readers', 'list', '--status', 'active', '--limit', '10']);
  assert.equal(code, 0);
  assert.match(out, /a@x.com {2}active/);
  assert.match(out, /1 of 1/);
  assert.equal(server.state.calls[1], `GET /newsletters/${NL}/readers?status=active&limit=10`);
});

test('issue new and preview', async () => {
  const made = await run(['issue', 'new', 'Week one', '--body', 'Hello']);
  assert.equal(made.code, 0);
  assert.match(made.out, /Draft saved: is-1 {2}Week one/);
  assert.deepEqual(made.server.state.bodies[1], { title: 'Week one', body_md: 'Hello' });

  const seen = await run(['issue', 'preview', 'is-1']);
  assert.equal(seen.code, 0);
  assert.match(seen.out, /Subject: Week one/);
  assert.match(seen.out, /Unsubscribe: https:\/\/u/);
});

test('send --dry-run sends nothing and lists who it would reach', async () => {
  const { code, out, server } = await run(['send', 'is-1', '--dry-run']);
  assert.equal(code, 0);
  assert.match(out, /Nothing was sent/);
  assert.match(out, /a@x.com/);
  assert.deepEqual(server.state.bodies[1], { dry_run: true });
});

test('a real send needs --yes, and a refusal says it is a person\'s action', async () => {
  const bare = await run(['send', 'is-1']);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /Nothing was sent/);
  assert.deepEqual(bare.server.state.calls, [], 'no call at all without --yes');

  const refused = await run(['send', 'is-1', '--yes'], fakeServer({ sendStatus: 403 }));
  assert.equal(refused.code, 1);
  assert.equal(refused.err, PERSON_ONLY);

  const sent = await run(['send', 'is-1', '--yes']);
  assert.equal(sent.code, 0);
  assert.equal(sent.out, 'Sent to 1 reader.');
});

test('more than one newsletter asks for --newsletter', async () => {
  const two = fakeServer({ newsletters: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  const { code, err } = await run(['readers', 'list'], two);
  assert.equal(code, 1);
  assert.match(err, /--newsletter/);
});

test('--json prints the server answer', async () => {
  const { out } = await run(['send', 'is-1', '--dry-run', '--json']);
  assert.equal(JSON.parse(out).would_send, 1);
});
