'use strict';

// atris nexus mail / reply, with every backend call faked. No real mail is read or sent.
// Only made-up people and inboxes appear here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand } = require('../commands/nexus');
const { replyRef } = require('../commands/nexus-mail');

const NOW = new Date(2026, 10, 15, 21);
const RAE = '11111111-1111-4111-8111-111111111111';

function card(id, name, email) {
  return { id, mine: true, name, private: { stage: 'found', closeness: 1, email } };
}

function conversations() {
  return {
    email: 'rae@example.com',
    accounts: [
      { account_id: 'default', email: 'me@example.com', name: 'Me', status: 'ok' },
      { account_id: 'school', email: 'me@school.example.edu', name: 'School', status: 'ok' },
      { account_id: 'old', email: 'me@old.example.com', name: 'Old', status: 'reconnect' },
      { account_id: null, email: 'helper@atrismail.com', name: 'Atris mail', status: 'ok' },
    ],
    messages: [
      { source: 'gmail', account_id: 'school', account_email: 'me@school.example.edu', thread_id: 'th_school', message_id: 'm_school_2', direction: 'inbound', subject: 'Lab \u001b[31mtimes', snippet: 'See you Tuesday', at: '2026-11-14T18:00:00+00:00' },
      { source: 'atris', account_id: null, account_email: 'helper@atrismail.com', thread_id: null, message_id: 'atris_1', direction: 'outbound', subject: 'Hello', snippet: 'hi', at: '2026-11-13T10:00:00+00:00' },
      { source: 'gmail', account_id: 'default', account_email: 'me@example.com', thread_id: 'th_home', message_id: 'm_home_1', direction: 'inbound', subject: 'Coffee?', snippet: 'Free Friday?', at: '2026-11-12T09:00:00+00:00' },
    ],
    threads: [
      { account_id: 'school', account_email: 'me@school.example.edu', thread_id: 'th_school', subject: 'Lab times', last_at: '2026-11-14T18:00:00+00:00', reply_to_message_id: 'm_school_2', count: 1 },
      { account_id: 'default', account_email: 'me@example.com', thread_id: 'th_home', subject: 'Coffee?', last_at: '2026-11-12T09:00:00+00:00', reply_to_message_id: 'm_home_1', count: 1 },
    ],
  };
}

function backend({ people = [card(RAE, 'Rae Sample', 'rae@example.com')], convo = conversations(), reply } = {}) {
  const state = { calls: [], sends: [], refs: new Set() };
  const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    const method = options.method || 'GET';
    state.calls.push({ method, path: url.pathname, body: options.body, retries: options.retries });
    if (method === 'POST' && url.pathname === '/nexus/people/search') {
      const q = String(options.body.q || '').toLowerCase();
      const hits = people.filter((p) => p.name.toLowerCase().includes(q));
      return answer(200, { people: hits, total: hits.length });
    }
    if (method === 'GET' && url.pathname === `/nexus/people/${RAE}/conversations`) return answer(200, convo);
    if (method === 'POST' && url.pathname === `/nexus/people/${RAE}/reply`) {
      state.sends.push(options.body);
      if (reply) return reply(options.body);
      if (state.refs.has(options.body.ref)) return answer(200, { replayed: true, sent: null, account_id: options.body.account_id });
      state.refs.add(options.body.ref);
      return answer(200, { replayed: false, sent: { message_id: 'new1', thread_id: options.body.thread_id }, account_id: options.body.account_id, account_email: 'me@school.example.edu', subject: 'Re: Lab times' });
    }
    return answer(404, { detail: 'Not Found' });
  };
  return { state, request };
}

async function run(args, server, extra = {}) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (l) => out.push(String(l)), err: (l) => errs.push(String(l)), now: () => NOW, env: {},
    getToken: async () => ({ token: 't' }), apiRequestJson: server.request,
    client: () => ({ read: async () => { throw new Error('the saved list is never read'); }, write: async () => { throw new Error('never written'); } }),
    ...extra,
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

const REPLY = ['reply', 'Rae Sample', '--from', 'school', '--message', 'm_school_2', '--body', 'Tuesday works.'];

test('mail shows every inbox, each message naming its inbox, and a ready reply line per thread', async () => {
  const server = backend();
  const { code, out } = await run(['mail', 'Rae Sample'], server);
  assert.equal(code, 0);
  assert.match(out, /Rae Sample, rae@example.com/);
  assert.match(out, /me@school\.example\.edu  \(--from school\)/);
  assert.match(out, /me@old\.example\.com  \(--from old\)  needs reconnecting/);
  assert.match(out, /got   me@school\.example\.edu  Lab \[31mtimes/);
  assert.match(out, /  Atris mail, helper@atrismail\.com\n/);
  assert.match(out, /sent  Atris mail  Hello/);
  assert.match(out, /atris nexus reply "Rae Sample" --from school --message m_school_2 --body "<text>"/);
  assert.ok(!out.includes('\u001b'), 'a stranger\'s control characters never reach the terminal');
  assert.equal(server.state.sends.length, 0, 'reading never sends');
});

test('mail --json passes the store answer through for agents', async () => {
  const server = backend();
  const { code, out } = await run(['mail', 'Rae Sample', '--json'], server);
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.ok, true);
  assert.equal(data.id, RAE);
  assert.equal(data.messages.length, 3);
  assert.equal(data.threads[0].reply_to_message_id, 'm_school_2');
});

test('reply without --yes and no terminal shows the reply and sends nothing', async () => {
  const server = backend();
  const { code, out } = await run(REPLY, server, { confirm: async () => false });
  assert.equal(code, 1);
  assert.match(out, /From:    me@school\.example\.edu/);
  assert.match(out, /To:      rae@example\.com/);
  assert.match(out, /Answers: message m_school_2 in thread th_school/);
  assert.match(out, /Not sent\./);
  assert.equal(server.state.sends.length, 0);
});

test('reply --dry-run sends nothing, even with --yes', async () => {
  const server = backend();
  const { code, out } = await run([...REPLY, '--dry-run', '--yes'], server);
  assert.equal(code, 0);
  assert.match(out, /Dry run: nothing was sent\./);
  assert.equal(server.state.sends.length, 0);
});

test('reply --json without --yes refuses instead of asking', async () => {
  const server = backend();
  let asked = false;
  const { code, out } = await run([...REPLY, '--json'], server, { confirm: async () => { asked = true; return true; } });
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).sent, false);
  assert.equal(asked, false);
  assert.equal(server.state.sends.length, 0);
});

test('reply after a yes sends once, from the named inbox, in the message\'s own thread', async () => {
  const server = backend();
  const { code, out } = await run(REPLY, server, { confirm: async () => true });
  assert.equal(code, 0, out);
  assert.equal(server.state.sends.length, 1);
  const sent = server.state.sends[0];
  assert.deepEqual({ ...sent, ref: undefined }, { ref: undefined, account_id: 'school', thread_id: 'th_school', message_id: 'm_school_2', body: 'Tuesday works.' });
  assert.equal(sent.ref, replyRef('school', 'th_school', 'm_school_2', 'Tuesday works.'));
  const call = server.state.calls.find((c) => c.path.endsWith('/reply'));
  assert.equal(call.retries, 0, 'a send is never retried by the transport');
  assert.match(out, /Sent from me@school\.example\.edu to Rae Sample, in the thread "Re: Lab times"\./);
});

test('the same reply run twice sends once; the second run is a replay', async () => {
  const server = backend();
  assert.equal((await run([...REPLY, '--yes'], server)).code, 0);
  const again = await run([...REPLY, '--yes', '--json'], server);
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).replayed, true);
  assert.equal(server.state.sends[0].ref, server.state.sends[1].ref);
  assert.equal(server.state.refs.size, 1);
});

test('--from also takes the inbox address', async () => {
  const server = backend();
  const args = ['reply', 'Rae Sample', '--from', 'ME@example.com', '--message', 'm_home_1', '--body', 'Friday works.', '--yes'];
  assert.equal((await run(args, server)).code, 0);
  assert.equal(server.state.sends[0].account_id, 'default');
  assert.equal(server.state.sends[0].thread_id, 'th_home');
});

test('a message in another inbox is refused, never sent from the wrong one', async () => {
  const server = backend();
  const { code, err } = await run(['reply', 'Rae Sample', '--from', 'default', '--message', 'm_school_2', '--body', 'x', '--yes'], server);
  assert.equal(code, 1);
  assert.match(err, /That message is in me@school\.example\.edu, not me@example\.com\. Nothing was sent\. .*--from school/);
  assert.equal(server.state.sends.length, 0);
});

test('reply needs --from and --message: nothing is guessed', async () => {
  const server = backend();
  const noFrom = await run(['reply', 'Rae Sample', '--message', 'm_school_2', '--body', 'x', '--yes'], server);
  assert.equal(noFrom.code, 2);
  assert.match(noFrom.err, /--from/);
  const noMessage = await run(['reply', 'Rae Sample', '--from', 'school', '--body', 'x', '--yes'], server);
  assert.equal(noMessage.code, 2);
  assert.match(noMessage.err, /--message/);
  const noBody = await run(['reply', 'Rae Sample', '--from', 'school', '--message', 'm_school_2', '--yes'], server);
  assert.equal(noBody.code, 2);
  assert.equal(server.state.calls.length, 0, 'bad words stop before any call');
});

test('an unknown inbox, an inbox needing reconnect, or the Atris mail row is refused', async () => {
  const server = backend();
  const unknown = await run(['reply', 'Rae Sample', '--from', 'work', '--message', 'm_school_2', '--body', 'x', '--yes'], server);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /No connected Gmail inbox matches "work"\. Nothing was sent\. Yours: /);
  const stale = await run(['reply', 'Rae Sample', '--from', 'old', '--message', 'm_school_2', '--body', 'x', '--yes'], server);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /needs reconnecting/);
  const atris = await run(['reply', 'Rae Sample', '--from', 'helper@atrismail.com', '--message', 'atris_1', '--body', 'x', '--yes'], server);
  assert.equal(atris.code, 1);
  assert.match(atris.err, /No connected Gmail inbox matches/);
  assert.equal(server.state.sends.length, 0);
});

test('a typo flag or --yes with a value never sends', async () => {
  const server = backend();
  const typo = await run([...REPLY, '--yse'], server);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /does not take --yse/);
  const valued = await run([...REPLY, '--yes=no'], server);
  assert.equal(valued.code, 2);
  assert.match(valued.err, /--yes takes no value/);
  assert.equal(server.state.calls.length, 0);
});

test('an older message not in the list needs --thread; a wrong --thread is refused', async () => {
  const server = backend();
  const older = await run(['reply', 'Rae Sample', '--from', 'school', '--message', 'm_old', '--body', 'x', '--yes'], server);
  assert.equal(older.code, 1);
  assert.match(older.err, /add --thread/);
  const wrong = await run([...REPLY, '--thread', 'th_other', '--yes'], server);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /is in thread th_school, not th_other/);
  assert.equal(server.state.sends.length, 0);
  const given = await run(['reply', 'Rae Sample', '--from', 'school', '--message', 'm_old', '--thread', 'th_older', '--body', 'x', '--yes'], server);
  assert.equal(given.code, 0, given.err);
  assert.equal(server.state.sends[0].thread_id, 'th_older');
});

test('a refused send says nothing was sent; an unknown outcome says check Sent', async () => {
  const gone = backend({ reply: () => ({ ok: false, status: 404, data: { detail: 'That conversation is not in this inbox, or this person is not on it. Nothing was sent.' } }) });
  const a = await run([...REPLY, '--yes', '--json'], gone);
  assert.equal(a.code, 1);
  assert.equal(JSON.parse(a.out).sent, false);
  assert.match(JSON.parse(a.out).error, /Nothing was sent/);

  const unsure = backend({ reply: () => ({ ok: false, status: 502, data: { detail: 'Gmail did not confirm the reply.' } }) });
  const b = await run([...REPLY, '--yes'], unsure);
  assert.equal(b.code, 1);
  assert.match(b.err, /Check Sent in that inbox\. Running this same command again will not send it twice\./);

  const dropped = backend({ reply: () => ({ ok: false, status: 0, data: null }) });
  const c = await run([...REPLY, '--yes', '--json'], dropped);
  assert.equal(JSON.parse(c.out).sent, null, 'a dropped connection is reported as unknown, not as not sent');
});

test('a locked store and a card with no email read plainly', async () => {
  const locked = { request: async () => ({ ok: false, status: 402, data: { detail: 'locked' } }) };
  const a = await run(['mail', 'Rae Sample'], locked);
  assert.equal(a.code, 1);
  assert.match(a.err, /Nexus needs a paid plan/);

  const bare = backend({ convo: { email: null, accounts: [{ account_id: 'default', email: 'me@example.com', status: 'skipped' }], messages: [], threads: [] } });
  const b = await run(['mail', 'Rae Sample'], bare);
  assert.equal(b.code, 0);
  assert.match(b.out, /This card has no email address, so no inbox was searched\./);
});
