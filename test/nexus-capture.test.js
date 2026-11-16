'use strict';

// atris nexus capture, with every backend call faked. Nothing real is saved or read. Only
// made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand } = require('../commands/nexus');
const { guessName, refFor } = require('../commands/nexus-capture');

const NOW = new Date(2026, 10, 16, 21);
const RAE = '11111111-1111-4111-8111-111111111111';
const RAE_TWO = '22222222-2222-4222-8222-222222222222';
const MESSY = 'Rae Sample, founder at Sample Co. Met at the Austin meetup, wants an intro to a designer. rae@example.com';

function cardOf(id, name, priv = {}) {
  return {
    id, mine: true, name, title: 'Founder', company_name: 'Sample Co', location_raw: 'Austin, TX',
    private: { stage: 'found', closeness: null, note: null, next_move: null, due_on: null, paid_cents: 0, paid_checked: false, last_touch_at: null, via_person_id: null, ...priv },
  };
}

function backend({ capture, cards } = {}) {
  const people = cards || { [RAE]: cardOf(RAE, 'Rae Sample'), [RAE_TWO]: cardOf(RAE_TWO, 'Rae Sample', { stage: 'met' }) };
  const state = { calls: [], captures: [] };
  const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const method = options.method || 'GET';
    state.calls.push({ method, path: pathname, body: options.body, retries: options.retries });
    if (method === 'POST' && pathname === '/nexus/capture') {
      state.captures.push(options.body);
      if (capture) return capture(options.body, state.captures.length);
      return answer(200, { person_id: RAE, name: options.body.name, made: true, matched_by: null, note_saved: true, follow_up_on: options.body.follow_up_on || null, needs_fill: true, choices: [] });
    }
    const m = /^\/nexus\/people\/([^/?]+)$/.exec(pathname);
    if (method === 'GET' && m && people[m[1]]) return answer(200, { card: people[m[1]], ties: [], touches: [{ kind: 'note', body: 'wants an intro', at: '2026-11-16T21:00:00+00:00' }] });
    return answer(404, { detail: 'Not Found' });
  };
  return { state, request };
}

const twoChoices = () => ({
  person_id: null, name: 'Rae Sample', made: false, matched_by: null, note_saved: false, follow_up_on: null, needs_fill: false,
  choices: [
    { person_id: RAE, name: 'Rae Sample', title: 'Founder', company: 'Sample Co' },
    { person_id: RAE_TWO, name: 'Rae Sample', title: 'Designer', company: 'Other Inc' },
  ],
});

async function run(args, server = backend(), deps = {}) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (line) => out.push(String(line)),
    err: (line) => errs.push(String(line)),
    getToken: async () => ({ token: 'tok' }),
    apiRequestJson: server.request,
    now: () => NOW,
    isTTY: false,
    stdin: async () => { throw new Error('standard input was not supposed to be read'); },
    ...deps,
  });
  return { code, out: out.join('\n'), err: errs.join('\n'), server };
}

test('the text goes in the request body, never in a web address, and the card prints like atris nexus "<name>"', async () => {
  const { code, out, server } = await run(['capture', MESSY]);
  assert.equal(code, 0, out);
  assert.equal(server.state.captures.length, 1);
  const sent = server.state.captures[0];
  assert.equal(sent.words, MESSY);
  assert.equal(sent.name, 'Rae Sample');
  assert.equal(sent.email, 'rae@example.com');
  assert.equal(sent.source, 'command_line');
  assert.match(sent.ref, /^cli-[0-9a-f]{40}$/);
  assert.equal(server.state.calls[0].retries, 0, 'a save is sent once');
  for (const call of server.state.calls) {
    assert.ok(!/Rae|Sample|meetup|example\.com/i.test(call.path), `no words in the address: ${call.path}`);
  }
  assert.match(out, /^Saved a new card for Rae Sample\./m);
  assert.match(out, /Their words are kept as a note\./);
  assert.match(out, /The name was read from your text/);
  assert.match(out, /^Rae Sample$/m);
  assert.match(out, /Founder · Sample Co · Austin, TX/);
  assert.doesNotMatch(out, /Stage:/, 'a new card is Found, which the card does not repeat');
  assert.match(out, /wants an intro/);
});

test('flags beat the text: --name, --company, --title, --city, --email, --linkedin and --follow-up', async () => {
  const { code, out, server } = await run([
    'capture', '--name', 'Rae S. Sample', '--company', 'Sample Co', '--title', 'Founder', '--city', 'Austin', '--email', 'rae@work.example',
    '--linkedin', 'https://www.linkedin.com/in/rae-sample', '--follow-up', 'tomorrow', 'someone from the meetup, rae@example.com',
  ]);
  assert.equal(code, 0, out);
  const sent = server.state.captures[0];
  assert.equal(sent.name, 'Rae S. Sample');
  assert.equal(sent.company, 'Sample Co');
  assert.equal(sent.title, 'Founder');
  assert.equal(sent.city, 'Austin');
  assert.equal(sent.email, 'rae@work.example');
  assert.equal(sent.linkedin_url, 'https://www.linkedin.com/in/rae-sample');
  assert.equal(sent.follow_up_on, '2026-11-17');
  assert.equal(sent.words, 'someone from the meetup, rae@example.com');
  assert.doesNotMatch(out, /The name was read from your text/);
  assert.match(out, /Follow-up 2026-11-17\./);
});

test('a LinkedIn link and one email in the text are used; two different emails are not guessed between', async () => {
  const one = await run(['capture', 'Rae Sample https://www.linkedin.com/in/rae-sample/ and rae@example.com']);
  assert.equal(one.server.state.captures[0].email, 'rae@example.com');
  assert.equal(one.server.state.captures[0].linkedin_url, 'https://www.linkedin.com/in/rae-sample');
  const two = await run(['capture', 'Rae Sample rae@example.com or rae@home.example']);
  assert.equal(two.server.state.captures[0].email, undefined);
});

test('no text on the command line reads standard input, so pbpaste | atris nexus capture works', async () => {
  const { code, out, server } = await run(['capture'], backend(), { stdin: async () => `${MESSY}\n` });
  assert.equal(code, 0, out);
  assert.equal(server.state.captures[0].words, MESSY);
  assert.equal(server.state.captures[0].name, 'Rae Sample');
});

test('with a terminal and no text it says how, and never waits on standard input', async () => {
  const { code, err, server } = await run(['capture'], backend(), { isTTY: true });
  assert.equal(code, 2);
  assert.match(err, /needs the text/);
  assert.match(err, /pbpaste \| atris nexus capture/);
  assert.equal(server.state.calls.length, 0);
});

test('empty piped text saves nothing', async () => {
  const { code, err, server } = await run(['capture'], backend(), { stdin: async () => '  \n ' });
  assert.equal(code, 2);
  assert.match(err, /no text to save/);
  assert.equal(server.state.calls.length, 0);
});

test('when the text has no name it asks for --name and calls nothing', async () => {
  const { code, err, server } = await run(['capture', 'met someone at the meetup, wants an intro']);
  assert.equal(code, 2);
  assert.match(err, /could not find a name/);
  assert.match(err, /--name/);
  assert.equal(server.state.calls.length, 0);
});

test('an unknown flag or a flag missing its value is refused before anything is sent; dashes in the text stay text', async () => {
  const typo = await run(['capture', '--follow', 'tomorrow', MESSY]);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /does not take --follow/);
  const bare = await run(['capture', MESSY, '--new=yes']);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /--new takes no value/);
  const hungry = await run(['capture', MESSY, '--company']);
  assert.equal(hungry.code, 2);
  assert.match(hungry.err, /--company needs a value/);
  for (const r of [typo, bare, hungry]) assert.equal(r.server.state.calls.length, 0);
  const dashes = await run(['capture', '--', '--- Rae Sample, founder ---']);
  assert.equal(dashes.code, 0, dashes.out);
  assert.equal(dashes.server.state.captures[0].words, '--- Rae Sample, founder ---');
  const dated = await run(['capture', '--follow-up', 'soon', MESSY]);
  assert.equal(dated.code, 2);
  assert.match(dated.err, /not a date/);
  assert.equal(dated.server.state.calls.length, 0);
});

test('a name that could be two of your cards, with no terminal: one JSON object, exit 3, nothing saved, nothing guessed', async () => {
  const server = backend({ capture: () => ({ ok: true, status: 200, data: twoChoices() }) });
  const { code, out } = await run(['capture', MESSY], server);
  assert.equal(code, 3);
  const data = JSON.parse(out);
  assert.equal(data.ok, false);
  assert.equal(data.saved, false);
  assert.equal(data.needs_choice, true);
  assert.deepEqual(data.choices.map((c) => [c.number, c.person_id, c.title]), [[1, RAE, 'Founder'], [2, RAE_TWO, 'Designer']]);
  assert.match(data.error, /--person <person_id>/);
  assert.equal(server.state.captures.length, 1, 'one ask, then it stops');
  assert.equal(server.state.captures[0].person_id, undefined);
  assert.equal(server.state.captures[0].new, undefined);
  assert.ok(!server.state.calls.some((c) => c.method === 'GET'), 'no card is shown when nothing was saved');
});

test('--json with a terminal still prints the choices and does not ask', async () => {
  const server = backend({ capture: () => ({ ok: true, status: 200, data: twoChoices() }) });
  let asked = false;
  const { code, out } = await run(['capture', '--json', MESSY], server, { isTTY: true, ask: async () => { asked = true; return '1'; } });
  assert.equal(code, 3);
  assert.equal(JSON.parse(out).choices.length, 2);
  assert.equal(asked, false);
  assert.equal(server.state.captures.length, 1);
});

test('on a terminal the choices are numbered and a number picks that card, in a call of its own', async () => {
  const server = backend({
    capture: (body) => ({ ok: true, status: 200, data: body.person_id ? { person_id: body.person_id, name: 'Rae Sample', made: false, matched_by: null, note_saved: true, follow_up_on: null, needs_fill: false, choices: [] } : twoChoices() }),
  });
  const asked = [];
  const { code, out } = await run(['capture', MESSY], server, { isTTY: true, ask: async (question) => { asked.push(question); return '2'; } });
  assert.equal(code, 0, out);
  assert.match(out, /Nothing saved yet\. Rae Sample could be someone already on your list:/);
  assert.match(out, /  1\. Rae Sample, Founder at Sample Co/);
  assert.match(out, /  2\. Rae Sample, Designer at Other Inc/);
  assert.match(out, /  n\. Someone new/);
  assert.equal(asked.length, 1);
  assert.equal(server.state.captures.length, 2);
  assert.equal(server.state.captures[1].person_id, RAE_TWO);
  assert.notEqual(server.state.captures[1].ref, server.state.captures[0].ref);
  assert.match(out, /Added to the card for Rae Sample\./);
  assert.match(out, /Stage: Met/, 'the card shown is the one picked');
  assert.deepEqual(server.state.calls.at(-1), { method: 'GET', path: `/nexus/people/${RAE_TWO}`, body: undefined, retries: undefined });
});

test('"n" on a terminal makes someone new; Enter cancels and saves nothing', async () => {
  const pick = (reply) => backend({
    capture: (body) => ({ ok: true, status: 200, data: body.new ? { person_id: RAE, name: 'Rae Sample', made: true, matched_by: null, note_saved: true, follow_up_on: null, needs_fill: true, choices: [] } : twoChoices() }),
  });
  const fresh = pick();
  const made = await run(['capture', MESSY], fresh, { isTTY: true, ask: async () => 'n' });
  assert.equal(made.code, 0, made.out);
  assert.equal(fresh.state.captures[1].new, true);
  assert.equal(fresh.state.captures[1].person_id, undefined);
  assert.match(made.out, /Saved a new card for Rae Sample\./);

  const cancelled = pick();
  const none = await run(['capture', MESSY], cancelled, { isTTY: true, ask: async () => '' });
  assert.equal(none.code, 1);
  assert.match(none.out, /Nothing was saved\./);
  assert.equal(cancelled.state.captures.length, 1);

  const wrong = pick();
  const nine = await run(['capture', MESSY], wrong, { isTTY: true, ask: async () => '9' });
  assert.equal(nine.code, 1);
  assert.equal(wrong.state.captures.length, 1, 'a number that is not on the list is not a pick');
});

test('--person and --new answer the question without a terminal; a bad id is refused', async () => {
  const server = backend();
  const done = await run(['capture', '--person', RAE_TWO, MESSY], server);
  assert.equal(done.code, 0, done.out);
  assert.equal(server.state.captures[0].person_id, RAE_TWO);
  const fresh = await run(['capture', '--new', MESSY]);
  assert.equal(fresh.server.state.captures[0].new, true);
  const bad = await run(['capture', '--person', 'not-an-id', MESSY]);
  assert.equal(bad.code, 2);
  assert.equal(bad.server.state.calls.length, 0);
  const both = await run(['capture', '--person', RAE, '--new', MESSY]);
  assert.equal(both.code, 2);
  assert.equal(both.server.state.calls.length, 0);
});

test('--json on a save prints one JSON object with the store answer and the card', async () => {
  const { code, out } = await run(['capture', '--json', MESSY]);
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.ok, true);
  assert.equal(data.saved, true);
  assert.equal(data.person_id, RAE);
  assert.equal(data.made, true);
  assert.equal(data.name_from, 'text');
  assert.equal(data.card.id, RAE);
});

test('long text: the store keeps 4000 characters as the note and takes 20000 in one request', async () => {
  const note = `Rae Sample ${'a'.repeat(5000)}`;
  const cut = await run(['capture', note]);
  assert.match(cut.out, /Only the first 4000 characters are kept as the note\./);
  assert.equal(cut.server.state.captures[0].words.length, note.length);
  const huge = await run(['capture', `Rae Sample ${'b'.repeat(25000)}`]);
  assert.equal(huge.server.state.captures[0].words.length, 20000);
});

test('the same text the same day makes the same ref, so a retry never saves twice; another day or another pick does not', () => {
  const a = refFor('Rae Sample', MESSY, '', false, NOW);
  assert.equal(a, refFor('Rae Sample', MESSY, '', false, new Date(2026, 10, 16, 8)));
  assert.notEqual(a, refFor('Rae Sample', MESSY, '', false, new Date(2026, 10, 17, 8)));
  assert.notEqual(a, refFor('Rae Sample', MESSY, RAE, false, NOW));
  assert.notEqual(a, refFor('Rae Sample', MESSY, '', true, NOW));
  assert.notEqual(a, refFor('Rae Sample', `${MESSY}!`, '', false, NOW));
});

test('not signed in, a paused store and a locked plan each stop with one plain line and save nothing more', async () => {
  const signedOut = await run(['capture', MESSY], backend(), { getToken: async () => ({ token: '' }) });
  assert.equal(signedOut.code, 1);
  assert.match(signedOut.err, /[Ss]ign in|atris login/);
  assert.equal(signedOut.server.state.calls.length, 0);

  const locked = await run(['capture', MESSY], backend({ capture: () => ({ ok: false, status: 402, data: { detail: 'plan' } }) }));
  assert.equal(locked.code, 1);
  assert.match(locked.err, /Nexus needs a paid plan/);

  const paused = await run(['capture', MESSY], backend({ capture: () => ({ ok: false, status: 503, data: {} }) }));
  assert.equal(paused.code, 1);
  assert.match(paused.err, /paused/);

  const down = await run(['capture', '--json', MESSY], backend({ capture: () => ({ ok: false, status: 500, data: {} }) }));
  assert.equal(down.code, 1);
  assert.equal(JSON.parse(down.out).ok, false);
  assert.ok(!down.out.includes('Sample'), 'the error never echoes the text');
});

test('if the card cannot be shown after saving, the save still counts', async () => {
  const server = backend({ cards: {} });
  const { code, out } = await run(['capture', MESSY], server);
  assert.equal(code, 0);
  assert.match(out, /Saved a new card for Rae Sample\./);
  assert.match(out, /could not be shown just now/);
});

test('reading a name out of messy text', () => {
  const cases = [
    ['Rae Sample, founder at Sample Co', 'Rae Sample'],
    ['Met Rae Sample at the Austin meetup', 'Rae Sample'],
    ['just met Dr. Rae Sample - works on lab software', 'Rae Sample'],
    ['Rae Sample (Sample Co) wants an intro', 'Rae Sample'],
    ['- Rae Sample\n  founder, Sample Co', 'Rae Sample'],
    ['Quick call with Rae Sample today', 'Rae Sample'],
    ['Name: Rae Sample\nCompany: Sample Co', 'Rae Sample'],
    ['Priya, founder of a design studio', 'Priya'],
    ['Priya', 'Priya'],
    ['Jean-Luc de la Sample, CTO', 'Jean-Luc de la Sample'],
    ["Ana O'Brien from Dublin", "Ana O'Brien"],
    ['J. Sample Jr., sales', 'J. Sample Jr.'],
    ['met at the conference, rae.sample@example.com', 'Rae Sample'],
    ['met someone at the meetup, wants an intro', ''],
    ['Coffee tomorrow', ''],
    ['', ''],
  ];
  for (const [text, want] of cases) {
    const emails = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []);
    assert.equal(guessName(text, emails), want, JSON.stringify(text));
  }
});
