'use strict';

// atris nexus capture, with every backend call faked. Nothing real is saved or read. Only
// made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand } = require('../commands/nexus');
const { guessName, refFor, permalinkOf, reasonRef } = require('../commands/nexus-capture');

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

// ---- --why and --source-url: the reason note the Chrome extension also writes ----

const VID = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s&si=abc&list=PL1&utm_source=x#frag';

test('--why with --source-url sends the exact extension note as private words, with no source_url and no public fields', async () => {
  const { code, out, server } = await run(['capture', '--name', 'Rae Sample', '--why', 'her talk\n on pricing   fits our ask', '--source-url', VID]);
  assert.equal(code, 0, out);
  assert.equal(server.state.captures.length, 1);
  const sent = server.state.captures[0];
  assert.equal(sent.words, 'Why reach out: her talk on pricing fits our ask\nSource: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s');
  assert.equal(sent.source, 'command_line', 'command_line keeps the store from treating the page as a public profile');
  assert.equal(sent.name, 'Rae Sample');
  for (const key of ['source_url', 'note', 'group_name', 'email', 'linkedin_url', 'x', 'website']) assert.equal(sent[key], undefined, key);
  assert.match(sent.ref, /^cli-why-[0-9a-f]{40}$/);
  assert.equal(server.state.calls[0].retries, 0);
  for (const call of server.state.calls) assert.ok(!/pricing|youtube/i.test(call.path), `no words in the address: ${call.path}`);
  assert.match(out, /reason and the page are kept as a private note/);
  assert.match(out, /Source: https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ&t=95s/);
});

test('--why alone saves just the Why line; the --json answer says what was kept', async () => {
  const { code, out, server } = await run(['capture', '--json', '--name', 'Rae Sample', '--why', 'asked about hiring']);
  assert.equal(code, 0, out);
  assert.equal(server.state.captures[0].words, 'Why reach out: asked about hiring');
  const data = JSON.parse(out);
  assert.equal(data.saved, true);
  assert.equal(data.why, 'asked about hiring');
  assert.equal(data.source_url, null);
  assert.equal(data.name_from, 'flag');
});

test('--why with --person pins the card and takes its name from it; an unknown id saves nothing', async () => {
  const server = backend();
  const done = await run(['capture', '--person', RAE_TWO, '--why', 'pricing talk'], server);
  assert.equal(done.code, 0, done.out);
  assert.equal(server.state.captures[0].person_id, RAE_TWO);
  assert.equal(server.state.captures[0].name, 'Rae Sample');
  const missing = await run(['capture', '--person', '33333333-3333-4333-8333-333333333333', '--why', 'pricing talk']);
  assert.equal(missing.code, 1);
  assert.equal(missing.server.state.captures.length, 0);
});

test('a name that could be two cards asks first with --why too, and the pick keeps the same note', async () => {
  const server = backend({ capture: (_body, n) => (n === 1 ? { ok: true, status: 200, data: twoChoices() } : undefined) });
  const asked = await run(['capture', '--name', 'Rae Sample', '--why', 'pricing talk'], server);
  assert.equal(asked.code, 3);
  assert.equal(JSON.parse(asked.out).needs_choice, true);
  const picked = await run(['capture', '--name', 'Rae Sample', '--person', RAE, '--why', 'pricing talk']);
  assert.equal(picked.code, 0);
  assert.equal(picked.server.state.captures[0].words, server.state.captures[0].words);
  assert.notEqual(picked.server.state.captures[0].ref, server.state.captures[0].ref, 'a pinned card is its own save');
});

test('--why misuse is refused before any call, and ordinary capture is unchanged', async () => {
  for (const args of [
    ['capture', '--why', 'pricing talk'],
    ['capture', '--name', 'Rae Sample', '--why', '   '],
    ['capture', '--name', 'Rae Sample', '--why', 'pricing talk', 'more text'],
    ['capture', '--name', 'Rae Sample', '--source-url', VID, MESSY],
    ['capture', '--name', 'Rae Sample', '--why', 'pricing talk', '--source-url', 'javascript:alert(1)'],
    ['capture', '--name', 'Rae Sample', '--why', 'pricing talk', '--source-url', 'not a link'],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.server.state.calls.length, 0, args.join(' '));
  }
  const plain = await run(['capture', MESSY]);
  assert.equal(plain.server.state.captures[0].words, MESSY);
  assert.match(plain.server.state.captures[0].ref, /^cli-[0-9a-f]{40}$/);
});

test('a retry or another second of the same video makes the same ref; a different reason or person does not', () => {
  const at95 = permalinkOf(VID);
  const at300 = permalinkOf('https://youtu.be/dQw4w9WgXcQ?t=5m');
  assert.equal(at95.key, at300.key);
  const ref = (reason, page, pid = '') => reasonRef('Rae Sample', reason, page.key, pid, false);
  assert.equal(ref('pricing talk', at95), ref('pricing talk', at300));
  assert.equal(ref('pricing talk', at95), reasonRef(' rae  sample ', 'Pricing Talk'.toLowerCase(), at95.key, '', false));
  assert.notEqual(ref('pricing talk', at95), ref('hiring question', at95));
  assert.notEqual(ref('pricing talk', at95), ref('pricing talk', at95, RAE));
  assert.notEqual(ref('pricing talk', at95), ref('pricing talk', permalinkOf('https://example.com/a')));
});

test('page links are kept clean and meaningful, as the extension keeps them', () => {
  const url = (raw) => permalinkOf(raw).url;
  assert.equal(url('https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(url('https://youtu.be/dQw4w9WgXcQ?si=xyz&t=1h2m3s'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3723s');
  assert.equal(url('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(url('https://www.youtube.com/live/dQw4w9WgXcQ?pp=1'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(url('https://www.youtube.com/embed/dQw4w9WgXcQ?start=42'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
  assert.equal(url('https://www.youtube.com/shorts/dQw4w9WgXcQ?t=9'), 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.equal(url('https://www.youtube.com/@samplechannel/videos?view=0'), 'https://www.youtube.com/@samplechannel');
  assert.equal(url('https://youtube.com/channel/UCabc123/featured'), 'https://www.youtube.com/channel/UCabc123');
  assert.equal(url('https://user:pw@Example.COM/post/1?utm_source=x&id=2#top'), 'https://example.com/post/1');
  for (const bad of ['ftp://example.com/a', 'data:text/html,hi', 'javascript:alert(1)', 'example.com', '']) assert.ok(permalinkOf(bad).error, bad);
});

test('broken percent codes and unsupported YouTube identities refuse with one JSON object before any call', async () => {
  for (const page of [
    'https://www.youtube.com/%E0%A4%A',
    'https://www.youtube.com/@bad%ZZ',
    'https://www.youtube.com/watch?v=%E0%A4%A',
    'https://youtu.be/%ZZ',
    'https://example.com/%E0%A4%A',
    'https://youtube.com/watch?v=bad',
    'https://music.youtube.com/watch?v=bad',
    'https://youtu.be/bad',
    'https://youtube.com/shorts/bad',
    'https://youtube.com/embed/bad',
    'https://youtube.com/live/bad',
    'https://youtu.be/dQw4w9WgXcQ/extra',
    'https://youtube.com/watch/extra?v=dQw4w9WgXcQ',
    'https://music.youtube.com/live/dQw4w9WgXcQ/extra',
    'https://youtube.com/playlist?list=PL123&si=tracking',
    'https://music.youtube.com/playlist?list=PL456',
    'https://youtube.com/watch?list=PL123',
  ]) {
    const r = await run(['capture', '--json', '--name', 'Rae Sample', '--why', 'pricing talk', '--source-url', page]);
    assert.equal(r.code, 2, page);
    assert.equal(r.out.split('\n').length, 1, page);
    assert.equal(JSON.parse(r.out).ok, false, page);
    assert.match(JSON.parse(r.out).error, /page link.*nothing was saved/i, page);
    assert.equal(r.err, '', page);
    assert.equal(r.server.state.calls.length, 0, page);
  }
});

test('the CLI process returns a clean JSON refusal for broken percent decoding', (t) => {
  const fs = require('node:fs');
  const cwd = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'nexus-capture-cli-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/atris.js'), 'nexus', 'capture', '--json',
    '--name', 'Rae Sample', '--why', 'pricing talk', '--source-url', 'https://www.youtube.com/%E0%A4%A'], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test('music YouTube videos keep their identity and share retry refs with regular YouTube', async () => {
  const saved = [];
  for (const page of [
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&t=95&si=tracking&list=PL123#top',
    'https://youtu.be/dQw4w9WgXcQ?t=300',
    'https://music.youtube.com/watch?v=abcdefghijk&feature=share',
  ]) {
    const r = await run(['capture', '--json', '--name', 'Rae Sample', '--why', 'pricing talk', '--source-url', page]);
    assert.equal(r.code, 0, r.out);
    saved.push(r.server.state.captures[0]);
  }
  assert.equal(saved[0].words, 'Why reach out: pricing talk\nSource: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s');
  assert.equal(saved[0].ref, saved[1].ref);
  assert.notEqual(saved[0].ref, saved[2].ref);
  assert.match(saved[2].words, /watch\?v=abcdefghijk$/);
});

test('--why retry refs include every explicit identity hint, normalize equivalents and ignore hints on a pinned card', async () => {
  const save = async (flags) => {
    const r = await run(['capture', '--json', '--name', 'Rae Sample', '--why', 'pricing talk', '--source-url', VID, ...flags]);
    assert.equal(r.code, 0, r.out);
    return r.server.state.captures[0].ref;
  };
  const base = await save([]);
  for (const [flag, one, equivalent, other] of [
    ['--email', 'rae@example.com', ' RAE@EXAMPLE.COM ', 'other@example.com'],
    ['--linkedin', 'https://www.linkedin.com/in/rae-sample/', 'http://linkedin.com/in/RAE-SAMPLE?trk=tracking#top', 'https://www.linkedin.com/in/other'],
    ['--company', 'Sample Co', ' sample   CO ', 'Other Co'],
  ]) {
    const ref = await save([flag, one]);
    assert.notEqual(ref, base, flag);
    assert.equal(ref, await save([flag, equivalent]), flag);
    assert.notEqual(ref, await save([flag, other]), flag);
    const pinned = await save(['--person', RAE, flag, one]);
    assert.equal(pinned, await save(['--person', RAE, flag, other]), flag);
    assert.equal(pinned, await save(['--person', RAE]), flag);
    assert.notEqual(pinned, await save(['--person', RAE_TWO, flag, one]), flag);
  }
  const hints = ['--email', 'rae@example.com', '--linkedin', 'https://linkedin.com/in/rae', '--company', 'Sample Co'];
  const combined = await save(hints);
  for (let i = 1; i < hints.length; i += 2) {
    const changed = [...hints];
    changed[i] = i === 1 ? 'other@example.com' : i === 3 ? 'https://linkedin.com/in/other' : 'Other Co';
    assert.notEqual(combined, await save(changed), hints[i - 1]);
  }
  assert.equal(await save(['--linkedin', 'linkedin.com/in/%52ae']), await save(['--linkedin', 'https://uk.linkedin.com/in/rae/']));
  assert.equal(reasonRef('Rae Sample', 'pricing talk', '', RAE, false), reasonRef('R. Sample', 'Pricing  Talk', '', RAE.toUpperCase(), false));
});

test('--why refuses overlong reasons with the limit, preserves the boundary and counts Unicode characters', async () => {
  for (const char of ['x', '😀']) {
    const accepted = await run(['capture', '--json', '--name', 'Rae Sample', '--why', char.repeat(1000)]);
    assert.equal(accepted.code, 0, accepted.out);
    assert.equal(JSON.parse(accepted.out).why, char.repeat(1000));
    assert.equal(JSON.parse(accepted.out).text_cut, false);
    const refused = await run(['capture', '--json', '--name', 'Rae Sample', '--why', char.repeat(1001)]);
    assert.equal(refused.code, 2);
    assert.equal(refused.out.split('\n').length, 1);
    assert.equal(JSON.parse(refused.out).ok, false);
    assert.match(JSON.parse(refused.out).error, /--why.*1000 characters.*nothing was saved/);
    assert.equal(refused.server.state.calls.length, 0);
  }
  const spaced = await run(['capture', '--json', '--name', 'Rae Sample', '--why', `  ${'x '.repeat(500)}\n`]);
  assert.equal(spaced.code, 0, spaced.out);
  assert.equal(JSON.parse(spaced.out).why, 'x '.repeat(500).trim());
});
