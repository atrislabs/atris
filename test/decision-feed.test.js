'use strict';

// atris feed, local edition: cards from real local tasks in the cloud feed's
// shape, the plain-words and visual checks ported from the backend, and the
// decide path (a person only, exactly once, protected lanes wait).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const { plumbingWords, isPlainSentence } = require('../lib/feed-plain-words');
const visuals = require('../lib/feed-visuals');
const { fittingTasks, heldForPerson } = require('../lib/member-task-pick');
const { handles } = require('../commands/decision-feed');
const { readScoreboard } = require('../commands/goal');

const { project } = require('./helpers/feed-project');

function add(ctx, fields) {
  return tasks.addTask(ctx.db, { workspaceRoot: ctx.root, ...fields }).id;
}

function cards(ctx, filter = 'all') {
  return feed.listCards(ctx.root, { filter, limit: 100, env: ctx.env }).cards;
}

function cardsOf(ctx, taskId, filter = 'all') {
  return cards(ctx, filter).filter((card) => card.source.id === taskId);
}

function receipt(ctx, taskId, passed, stamp) {
  const dir = path.join(ctx.root, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  fs.writeFileSync(path.join(dir, `2026-11-14-task-${slug}-${stamp}.json`), JSON.stringify({
    schema: 'atris.task_receipt.v1', task_id: taskId, command: 'npm test', result: { passed, exit: passed ? 0 : 1 },
  }));
}

function propose(ctx, fields = {}) {
  return feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'Old leads answer more often', env: ctx.env, ...fields });
}

// ------------------------------------------------------------ plain words

const MUST_FAIL = {
  'Landed: review /pull/6 merged into master, commit 08ebaf9': ['/pull/6', 'merged', 'commit', '08ebaf9'],
  'Delivered on branch codex/member-operate/executor, pushed commit 22dd6252':
    ['branch', 'codex/member-operate/executor', 'commit', '22dd6252'],
  'task next --as arjuna finds no eligible work, retained both active worktrees': ['--as', 'worktrees'],
  'Fixed BCK-1234 in the backend': ['BCK-1234'],
  'Changed backend/services/feed.py today': ['backend/services/feed.py'],
  'See https://github.com/atrislabs/app/pull/88 for it': ['https://github.com/atrislabs/app/pull/88'],
  'git push origin main': ['git'],
  'Run `make test` before lunch': ['`'],
  'The getUserName helper broke': ['getUserName'],
  'Call load_member_file() again': ['load_member_file(', 'load_member_file'],
  'Added a new endpoint and a migration for the schema': ['endpoint', 'migration', 'schema'],
  'Opened a pull request against the repo': ['pull request', 'repo'],
  'Wrote the error to stderr as JSON': ['stderr', 'JSON'],
  'Two PRs are waiting': ['PRs'],
  'The API route now answers': ['API route'],
};
const MUST_PASS = [
  'Lets plan every day out, which calendar are you connected to',
  'can you find my linkedin',
  'Raise the price to $50?',
  'Three buyers said yes at $20, so I think we can charge more!',
  'Open 24/7 for the holidays, and follow up with LinkedIn and YouTube leads',
  'Text the iPhone owners on 2026-11-20 at 9:30',
];

test('plain words: the backend must-fail and must-pass examples', () => {
  for (const [text, words] of Object.entries(MUST_FAIL)) {
    const found = plumbingWords(text);
    for (const word of words) assert.ok(found.includes(word), `${text} -> ${JSON.stringify(found)}`);
  }
  for (const text of MUST_PASS) assert.deepEqual(plumbingWords(text), [], text);
  assert.ok(isPlainSentence('Nothing needs you today.'));
  assert.ok(!isPlainSentence('a.b'));
});

// ---------------------------------------------------------------- visuals

const MEDIA = 'https://atris-uploads.s3.us-east-1.amazonaws.com/text-visuals/chart.png';
const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" width="100" height="40">'
  + '<defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4af"/>'
  + '<stop offset="1" stop-color="#fa4"/></linearGradient></defs>'
  + '<g transform="translate(2,2)"><rect x="0" y="0" width="60" height="20" rx="4" fill="url(#sky)"/>'
  + '<circle cx="80" cy="10" r="8" style="fill: #333; stroke: none"/>'
  + '<path d="M0 30 L96 30" stroke="#999" stroke-width="2"/>'
  + '<text x="0" y="38" font-size="6" font-family="Inter, sans-serif">Sign ups doubled</text></g></svg>';
const GOOD_VISUALS = [
  { kind: 'metric', label: 'Paying customers', value: '$2,400', change: '+12% this week' },
  { kind: 'chart', chart: 'bar', title: 'Replies by day',
    data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => ({ label, value: [3, 5, 2, 8, 6, 1][i] })) },
  { kind: 'chart', chart: 'line', title: 'Visitors', unit: 'people', caption: 'after the new page',
    data: Array.from({ length: 8 }, (_, i) => ({ label: `Week ${i + 1}`, value: (i + 1) * 10.5 })) },
  { kind: 'before_after', before: 'Owners waited two days for a quote', after: 'Quotes go out the same hour' },
  { kind: 'steps', steps: ['Find the ten oldest leads', 'Write one short note each', 'Send before lunch'], caption: 'about an hour' },
  { kind: 'image', url: MEDIA, alt: 'The new price page' },
  { kind: 'drawing', svg: SVG_OK, alt: 'Sign ups doubled' },
];
const svg = (inner, rootAttrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${rootAttrs}>${inner}</svg>`;
const UNSAFE_SVG = {
  script: svg('<script>alert(1)</script>'),
  'on handler': svg('<rect width="5" height="5" onclick="alert(1)"/>'),
  'on handler on root': svg('<rect/>', ' onload="alert(1)"'),
  foreignObject: svg('<foreignObject width="5" height="5"><div>hi</div></foreignObject>'),
  'external href': svg('<a href="https://evil.example"><rect width="5" height="5"/></a>'),
  'xlink href': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/x.svg#a"/></svg>',
  image: svg('<image href="https://evil.example/x.png" width="5" height="5"/>'),
  'javascript url': svg('<rect fill="javascript:alert(1)" width="5" height="5"/>'),
  'javascript url by entity': svg('<rect fill="javascript&#58;alert(1)" width="5" height="5"/>'),
  'data html': svg('<rect fill="data:text/html;base64,PHNjcmlwdD4=" width="5" height="5"/>'),
  'css url in style': svg('<rect style="fill: url(https://evil.example/x)" width="5" height="5"/>'),
  'css url in attribute': svg('<rect fill="url(https://evil.example/x)" width="5" height="5"/>'),
  'style element': svg('<style>rect { fill: url(https://evil.example/x) }</style>'),
  'style import': svg('<rect style="fill: red; @import x" width="5" height="5"/>'),
  'unknown style property': svg('<rect style="behavior: x" width="5" height="5"/>'),
  animation: svg('<rect width="5" height="5"><animate attributeName="x" from="0" to="5"/></rect>'),
  set: svg('<rect width="5" height="5"><set attributeName="fill" to="red"/></rect>'),
  'doctype entity': '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"><text>&a;</text></svg>',
  'processing instruction': svg('<?xml-stylesheet href="https://evil.example/x.css"?><rect/>'),
  cdata: svg('<text><![CDATA[<script>alert(1)</script>]]></text>'),
  'markup in text': svg('<text>&lt;script&gt;alert(1)&lt;/script&gt;</text>'),
  'no svg namespace': '<svg viewBox="0 0 10 10"><rect/></svg>',
  'html root': '<html xmlns="http://www.w3.org/2000/svg"><rect/></html>',
  'not xml': '<svg><rect></svg>',
  'jargon in text': svg('<text>merged commit 08ebaf9</text>'),
  'prefixed svg element with an unbound prefix': '<s:svg><s:rect/></s:svg>',
  'unknown entity': svg('<text>&nbsp;</text>'),
};

test('visuals: every kind round-trips unchanged', () => {
  for (const visual of GOOD_VISUALS) assert.deepEqual(visuals.checkVisual(visual), visual);
  assert.equal(visuals.checkVisual(null), null);
});

test('visuals: every unsafe drawing is refused, never repaired', () => {
  for (const [name, drawing] of Object.entries(UNSAFE_SVG)) {
    assert.throws(() => visuals.checkVisual({ kind: 'drawing', svg: drawing, alt: 'A drawing' }), visuals.VisualRejected, name);
    assert.equal(visuals.safeVisual({ kind: 'drawing', svg: drawing, alt: 'A drawing' }), null, name);
  }
  const big = svg('<rect width="1" height="1"/>'.repeat(800));
  assert.ok(Buffer.byteLength(big) > visuals.SVG_MAX_BYTES);
  const bad = [
    { kind: 'drawing', svg: big, alt: 'Big' },
    { kind: 'image', url: 'https://evil.example/chart.png', alt: 'A chart' },
    { kind: 'image', url: 'http://atris-uploads.s3.us-east-1.amazonaws.com/a.png', alt: 'A chart' },
    { kind: 'image', url: 'https://user@atris-uploads.s3.us-east-1.amazonaws.com/a.png', alt: 'A chart' },
    { kind: 'image', url: 'https://atris-uploads.s3.us-east-1.amazonaws.com/page.html', alt: 'A page' },
    { kind: 'image', url: 'javascript:alert(1)', alt: 'A chart' },
    { kind: 'chart', chart: 'bar', title: 'Too many', data: Array.from({ length: 7 }, (_, i) => ({ label: `n${i}`, value: i })) },
    { kind: 'chart', chart: 'line', title: 'One point', data: [{ label: 'a', value: 1 }] },
    { kind: 'chart', chart: 'pie', title: 'Pie', data: [{ label: 'a', value: 1 }] },
    { kind: 'chart', chart: 'bar', title: 'Bad value', data: [{ label: 'a', value: '1' }] },
    { kind: 'steps', steps: ['one', 'two', 'three', 'four', 'five'] },
    { kind: 'metric', label: 'Paying customers', value: '20', html: '<b>x</b>' },
    { kind: 'html', html: '<script>alert(1)</script>' },
    { kind: 'metric', label: '<b>Paying</b>', value: '20' },
    'not an object',
  ];
  for (const visual of bad) assert.throws(() => visuals.checkVisual(visual), visuals.VisualRejected, JSON.stringify(visual).slice(0, 60));
  try {
    visuals.checkVisual({ kind: 'metric', label: 'Merged PRs this week', value: '12' });
    assert.fail('should refuse');
  } catch (error) {
    assert.deepEqual(error.words, ['Merged', 'PRs']);
  }
});

// --------------------------------------------------- task state -> card

test('cards: each local task state maps to its card', (t) => {
  const ctx = project(t);
  const idea = propose(ctx).card;
  const held = add(ctx, { title: 'Pick the price for the new plan', metadata: { tags: ['needs-human'], assigned_to: 'closer' } });
  const review = add(ctx, { title: 'Rewrite the welcome note', status: 'review', claimedBy: 'writer', metadata: { assigned_to: 'writer' } });
  const working = add(ctx, { title: 'Sort the inbox', status: 'claimed', claimedBy: 'scout' });
  const done = add(ctx, { title: 'Send the weekly note', status: 'done', metadata: { result: 'Sent to forty owners' } });
  const failed = add(ctx, { title: 'Fix the signup page', status: 'failed' });
  const plain = add(ctx, { title: 'Clean up old notes' });

  assert.equal(idea.kind, 'proposal');
  assert.equal(idea.state, 'pending');
  assert.equal(idea.needs_decision, true);
  assert.equal(idea.author.id, 'agent:scout');

  const [question] = cardsOf(ctx, held);
  assert.equal(question.kind, 'question');
  assert.equal(question.needs_decision, true);
  assert.equal(question.can_decide, true);

  const [accept] = cardsOf(ctx, review);
  assert.equal(accept.kind, 'question');
  assert.match(accept.id, /:accept$/);
  assert.equal(accept.needs_decision, true);
  assert.equal(accept.proof.status, 'unverified');

  assert.deepEqual(cardsOf(ctx, working), [], 'work in flight is off the main list');
  const [update] = cardsOf(ctx, working, 'working');
  assert.equal(update.kind, 'update');
  assert.equal(update.state, 'working');

  const [result] = cardsOf(ctx, done);
  assert.equal(result.kind, 'result');
  assert.equal(result.state, 'done');
  assert.equal(result.body, 'Sent to forty owners');
  assert.equal(result.story.length, 0, 'no model call: story stays empty without the member writing one');

  const [broken] = cardsOf(ctx, failed);
  assert.equal(broken.state, 'failed');
  assert.equal(broken.proof.status, 'unverified');

  assert.deepEqual(cardsOf(ctx, plain), [], 'plain open work has no card');

  const page = feed.listCards(ctx.root, { env: ctx.env });
  assert.equal(page.version, 'atris.feed.v1');
  assert.deepEqual(Object.keys(page).sort(), ['cards', 'counts', 'next_cursor', 'next_since', 'theme', 'version']);
  assert.equal(page.counts.needs_decision, 3);
  assert.equal(page.counts.working, 1);
  for (const key of ['id', 'kind', 'source', 'author', 'title', 'body', 'why', 'story', 'detail', 'visual', 'created_at',
    'state', 'needs_decision', 'can_decide', 'cannot_decide_reason', 'decision', 'proof', 'attempt', 'result_of',
    'backers', 'backer_count', 'message_count', 'last_message_at', 'revised_at']) {
    assert.ok(key in idea, key);
  }
  assert.ok(!Object.keys(idea).some((key) => key.startsWith('_')));
});

test('cards: mission cards show the work without the generated reward label', (t) => {
  const ctx = project(t);
  const title = 'Mission XP: Check the memory repair';
  const metadata = { mission_id: 'mission-memory-repair' };
  const working = add(ctx, { title, metadata, status: 'claimed', claimedBy: 'scout' });
  const done = add(ctx, { title, metadata, status: 'done' });
  const manual = add(ctx, { title, status: 'done' });

  assert.equal(cardsOf(ctx, working, 'working')[0].title, 'Check the memory repair');
  assert.equal(cardsOf(ctx, done)[0].title, 'Check the memory repair');
  assert.equal(cardsOf(ctx, manual)[0].title, title);
});

test('cards: a jargon title is kept in detail, never shown', (t) => {
  const ctx = project(t);
  const done = add(ctx, { title: 'Merged PR-12 into the repo', status: 'done' });
  const [card] = cardsOf(ctx, done, 'done');
  assert.equal(card.title, 'A piece of work finished');
  assert.match(card.detail, /PR-12/);
});

test('cards: finished work with a jargon title shows the plain words it reported; with none it waits under done', (t) => {
  const ctx = project(t);
  const said = add(ctx, { title: 'Merged PR-12 into the repo', status: 'done', metadata: { result: 'Merged in PR-12. Owners can now pay by card.' } });
  const finishLine = add(ctx, { title: 'Wire getUserName into lib/pay.js', status: 'done', metadata: { done_looks_like: 'The price page shows the new plan.' } });
  const empty = add(ctx, { title: 'Bump lib/pay.js to v2', status: 'done', metadata: { result: 'Merged commit 08ebaf9' } });
  const plainError = add(ctx, { title: 'Fix getUserName in lib/pay.js', status: 'failed', metadata: { last_error: 'The signup page would not load.' } });
  const rawError = add(ctx, { title: 'Fix getUserName in lib/pay.js', status: 'failed', metadata: { last_error: 'ENOENT at lib/pay.js. The page broke.' } });
  const running = add(ctx, { title: 'Fix getUserName in lib/pay.js', status: 'claimed', claimedBy: 'scout' });

  assert.equal(cardsOf(ctx, said)[0].title, 'Owners can now pay by card.');
  assert.match(cardsOf(ctx, said)[0].detail, /PR-12/, 'the raw title stays behind the detail');
  assert.equal(cardsOf(ctx, finishLine)[0].title, 'The price page shows the new plan.');
  assert.equal(cardsOf(ctx, plainError)[0].title, 'The signup page would not load.');
  for (const id of [empty, rawError]) {
    assert.deepEqual(cardsOf(ctx, id), [], 'nothing a person can read: off the main list');
    assert.match(cardsOf(ctx, id, 'done')[0].title, /^A piece of work (finished|did not finish)$/, 'still reachable under done');
  }
  const page = feed.listCards(ctx.root, { limit: 100, env: ctx.env });
  assert.equal(page.counts.new_results, page.cards.filter((card) => card.kind === 'result').length);
  assert.equal(page.counts.new_results, 3);
  assert.ok(!feed.listCards(ctx.root, { since: '0', limit: 100, env: ctx.env }).cards.some((card) => [empty, rawError].includes(card.source.id)));

  const [update] = cardsOf(ctx, running, 'working');
  assert.equal(update.title, 'A piece of work is under way', 'work still running is never titled as finished');
  assert.equal(update.state, 'working');
});

test('cards: finished work waiting for an ok says what was done, not only that it waits', (t) => {
  const ctx = project(t);
  const said = add(ctx, { title: 'Merged PR-12 into the repo', status: 'review', claimedBy: 'writer', metadata: { result: 'Merged in PR-12. Owners can now pay by card.' } });
  const empty = add(ctx, { title: 'Bump lib/pay.js to v2', status: 'review', claimedBy: 'writer', metadata: { result: 'Merged commit 08ebaf9' } });

  const [ask] = cardsOf(ctx, said).filter((card) => card.needs_decision);
  assert.equal(ask.title, 'Owners can now pay by card.');
  assert.match(ask.detail, /PR-12/, 'the raw title stays behind the detail');
  const [bare] = cardsOf(ctx, empty).filter((card) => card.needs_decision);
  assert.equal(bare.title, 'Finished work is waiting for your ok', 'a decision is never hidden, even with nothing plain to say');
});

// Moves a task's every time back by hours, as if it had sat that long.
function ageTask(ctx, id, hours) {
  const at = Date.now() - hours * 3600000;
  ctx.db.prepare('UPDATE tasks SET created_at = ?, updated_at = ?, done_at = CASE WHEN done_at IS NULL THEN NULL ELSE ? END WHERE id = ?').run(at, at, at, id);
}

function ageNote(ctx, cardId, hours) {
  const file = require('../lib/feed-room').notesFile(ctx.root);
  const at = new Date(Date.now() - hours * 3600000).toISOString();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const note = JSON.parse(line);
    return JSON.stringify(`post:${note.id}` === cardId ? { ...note, at } : note);
  });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

test('fresh: teammates answering each other do not hold an old note on the main list; in your own conversation they do', (t) => {
  const ctx = project(t);
  const room = require('../lib/feed-room');
  const team = require('../lib/feed-team');
  const theirs = room.say(ctx.root, { as: 'writer', text: 'The spring list is ready.', fromAsk: true, env: ctx.env, deps: ctx.deps }).card.id;
  const joined = room.say(ctx.root, { as: 'writer', text: 'The autumn list is ready.', fromAsk: true, env: ctx.env, deps: ctx.deps }).card.id;
  const mine = room.say(ctx.root, { text: 'Lets plan the week.', env: ctx.env, deps: ctx.deps }).card.id;
  room.reply(ctx.root, joined, 'Send it on Friday.', { env: ctx.env });
  for (const id of [theirs, joined, mine]) ageNote(ctx, id, 30);
  const social = room.socialFile(ctx.root);
  const old = new Date(Date.now() - 30 * 3600000).toISOString();
  const stored = JSON.parse(fs.readFileSync(social, 'utf8'));
  for (const entry of Object.values(stored)) { entry.updated_at = old; for (const reply of entry.replies || []) reply.at = old; }
  fs.writeFileSync(social, JSON.stringify(stored));
  const ids = () => cards(ctx).map((card) => card.id);
  assert.deepEqual(ids(), [], 'all three have been quiet for over a day');

  for (const id of [theirs, joined, mine]) room.reply(ctx.root, id, 'It went out to forty people.', { as: 'writer', direct: true, env: ctx.env, deps: ctx.deps });
  assert.ok(!ids().includes(theirs), 'a teammate alone on its own old note does not bring it back');
  assert.ok(ids().includes(joined), 'a note you commented on comes back when a teammate answers');
  assert.ok(ids().includes(mine), 'your own note comes back when a teammate answers');
  assert.ok(!feed.listCards(ctx.root, { since: '0', limit: 100, env: ctx.env }).cards.some((card) => card.id === theirs), 'and a delta does not bring it back either');
  assert.equal(feed.readCard(ctx.root, theirs, { env: ctx.env }).reply_count, 1, 'the note and its comment are still there to read');

  // The team is shown what you still see: the note that left is not brought up for more comments.
  const brief = team.roomBrief(ctx.root, 'writer', { env: ctx.env });
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief);
  assert.doesNotMatch(text, /spring list/, 'a note off the main list is not put in front of the team again');
  assert.match(text, /autumn list/, 'a note still on it is');
});

test('fresh: a result and a team note quiet for a day leave the main list; an idea waiting for you stays; a comment brings a note back', (t) => {
  const ctx = project(t);
  const room = require('../lib/feed-room');
  const result = add(ctx, { title: 'Send the weekly note', status: 'done' });
  const resultCard = cardsOf(ctx, result)[0].id;
  const note = room.say(ctx.root, { as: 'writer', text: 'The spring list is ready.', fromAsk: true, env: ctx.env, deps: ctx.deps }).card.id;
  const mine = room.say(ctx.root, { text: 'Lets plan the week.', env: ctx.env, deps: ctx.deps }).card.id;
  const idea = propose(ctx).card;
  for (const id of [result, idea.source.id]) ageTask(ctx, id, 25);
  ageNote(ctx, note, 25);
  ageNote(ctx, mine, 25);

  const ids = () => cards(ctx).map((card) => card.id);
  assert.deepEqual(ids(), [idea.id], 'only the idea waiting for a decision is left');
  assert.ok(cards(ctx, 'done').some((card) => card.id === resultCard), 'the old result stays under done');
  const page = feed.listCards(ctx.root, { limit: 100, env: ctx.env });
  assert.equal(page.counts.new_results, 0, 'an aged-out result is not counted as new');
  assert.ok(!feed.listCards(ctx.root, { since: '0', limit: 100, env: ctx.env }).cards.some((card) => [resultCard, note, mine].includes(card.id)),
    'a delta never brings an aged-out card back by itself');

  room.reply(ctx.root, note, 'Still true today.', { env: ctx.env });
  assert.ok(ids().includes(note), 'a new comment makes the note fresh again');
  assert.ok(feed.listCards(ctx.root, { since: '0', limit: 100, env: ctx.env }).cards.some((card) => card.id === note));

  const longer = { ...ctx.env, ATRIS_FEED_FRESH_HOURS: '48' };
  const wide = feed.listCards(ctx.root, { limit: 100, env: longer });
  assert.ok(wide.cards.some((card) => card.id === resultCard), 'the window can be made longer');
  assert.equal(wide.counts.new_results, wide.cards.filter((card) => card.kind === 'result').length);
  assert.equal(wide.counts.new_results, 1);
  for (const bad of ['0', '-3', 'soon']) {
    assert.ok(!feed.listCards(ctx.root, { limit: 100, env: { ...ctx.env, ATRIS_FEED_FRESH_HOURS: bad } }).cards.some((card) => card.id === resultCard), bad);
  }
});

function captured(fn) {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  return Promise.resolve().then(fn).finally(() => { console.log = log; }).then((code) => ({ code, text: lines.join('\n') }));
}

test('dismiss: any card leaves your feed; an idea waiting for you is dismissed as a decision; undo brings a hidden card back', async (t) => {
  const ctx = project(t);
  const room = require('../lib/feed-room');
  const { run } = require('../commands/decision-feed');
  const done = add(ctx, { title: 'Send the weekly note', status: 'done' });
  const result = cardsOf(ctx, done)[0];
  const note = room.say(ctx.root, { as: 'writer', text: 'The spring list is ready.', fromAsk: true, env: ctx.env, deps: ctx.deps }).card;
  const mine = room.say(ctx.root, { text: 'Lets plan the week.', env: ctx.env, deps: ctx.deps }).card;
  const idea = propose(ctx).card;
  const before = tasks.getTask(ctx.db, done).updated_at;

  const cli = await captured(() => run(['dismiss', result.id, note.id, mine.id, idea.id, 'task:nope:1:result', 'post:000000000000', '--json'], { cwd: ctx.root, env: ctx.env, deps: ctx.deps }));
  assert.equal(cli.code, 0);
  const out = JSON.parse(cli.text);
  assert.deepEqual(Object.keys(out).sort(), ['dismissed', 'skipped', 'version']);
  assert.deepEqual(out.dismissed, [result.id, note.id, mine.id, idea.id]);
  assert.deepEqual(out.skipped.map((s) => s.id), ['task:nope:1:result', 'post:000000000000'], 'unknown ids are skipped, the rest still go');
  assert.ok(out.skipped.every((s) => s.reason === 'No card with that id.'));

  assert.deepEqual(cards(ctx), [], 'nothing left on the main list');
  for (const filter of ['done', 'working', 'needs_decision', 'parked']) assert.deepEqual(cards(ctx, filter), [], filter);
  const hidden = cards(ctx, 'dismissed');
  assert.deepEqual(hidden.map((card) => card.id).sort(), [result.id, note.id, mine.id, idea.id].sort());
  assert.equal(hidden.find((card) => card.id === result.id).seen, true, 'a dismissed result counts as read');
  assert.equal(hidden.find((card) => card.id === note.id).dismissed, true);
  assert.equal(tasks.getTask(ctx.db, done).updated_at, before, 'hiding is not a change to the work');
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.new_results, 0);
  assert.equal(feed.listCards(ctx.root, { since: '0', limit: 100, env: ctx.env }).cards.filter((card) => card.id !== idea.id).length, 0);
  // The idea went the decide way: archived, with the decision on it.
  assert.equal(tasks.getTask(ctx.db, idea.source.id).status, 'archived');
  assert.equal(hidden.find((card) => card.id === idea.id).decision.choice, 'dismiss');

  const friend = { ...ctx.env, USER: 'friend' };
  const theirs = feed.listCards(ctx.root, { limit: 100, env: friend }).cards.map((card) => card.id);
  for (const id of [result.id, note.id, mine.id]) assert.ok(theirs.includes(id), `someone else still sees ${id}`);

  const back = feed.dismissCards(ctx.root, [result.id, note.id], { env: ctx.env, undo: true });
  assert.deepEqual(back.restored, [result.id, note.id]);
  assert.deepEqual(back.skipped, []);
  assert.deepEqual(cards(ctx).map((card) => card.id).sort(), [result.id, note.id].sort(), 'back where they were');
  assert.deepEqual(feed.dismissCards(ctx.root, [result.id], { env: ctx.env, undo: true }).skipped, [{ id: result.id, reason: 'It was not dismissed.' }]);
  assert.throws(() => feed.dismissCards(ctx.root, [idea.id], { env: ctx.env, undo: true }), (e) => e.status === 409 && /dismissed as a decision/.test(e.message));

  assert.throws(() => feed.dismissCards(ctx.root, [result.id], { env: ctx.agentEnv }), (e) => e.status === 403);
  assert.throws(() => feed.dismissCards(ctx.root, Array.from({ length: 51 }, (_, i) => `post:${String(i).padStart(12, '0')}`), { env: ctx.env }), (e) => e.status === 413);
  const help = await captured(() => run(['--help'], { cwd: ctx.root, env: ctx.env }));
  assert.match(help.text, /feed dismiss <card>/);
  assert.match(help.text, /quiet for 24 hours/);
});

test('proof: verified only when a real passing receipt exists', (t) => {
  const ctx = project(t);
  const none = add(ctx, { title: 'Tidy the price page', status: 'done', metadata: { latest_agent_proof: 'all checks pass, trust me' } });
  const good = add(ctx, { title: 'Tidy the about page', status: 'done' });
  const flipped = add(ctx, { title: 'Tidy the help page', status: 'done' });
  receipt(ctx, good, true, '2026-11-14T08-00-00-000Z');
  receipt(ctx, flipped, true, '2026-11-14T08-00-00-000Z');
  receipt(ctx, flipped, false, '2026-11-14T09-00-00-000Z');
  assert.equal(cardsOf(ctx, none)[0].proof.status, 'unverified');
  const verified = cardsOf(ctx, good)[0].proof;
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.checks, [{ name: 'npm test', passed: true }]);
  assert.match(verified.uri, /^atris\/runs\//);
  assert.equal(cardsOf(ctx, flipped)[0].proof.status, 'unverified', 'the newest receipt failed');

  // A receipt the proof names counts only if it passed.
  const cited = add(ctx, { title: 'Tidy the team page', status: 'done' });
  const dir = path.join(ctx.root, 'atris', 'runs');
  fs.writeFileSync(path.join(dir, 'check-a.json'), JSON.stringify({ result: { passed: true } }));
  tasks.updateTaskMetadata(ctx.db, cited, (m) => { m.latest_agent_proof = 'ran it: atris/runs/check-a.json'; return m; });
  assert.equal(cardsOf(ctx, cited)[0].proof.status, 'verified');
  fs.writeFileSync(path.join(dir, 'check-a.json'), JSON.stringify({ result: { passed: false } }));
  assert.equal(cardsOf(ctx, cited)[0].proof.status, 'unverified');
});

// ------------------------------------------------------------------- theme

test('theme: reuses the atris goal, one plain sentence, people only', (t) => {
  const ctx = project(t);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).theme.text, null);
  const out = feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  assert.equal(out.theme.text, 'Get ten paying customers by December', 'shown exactly as typed');
  const board = readScoreboard(ctx.root);
  assert.equal(board.goal, 'get ten paying customers by december', 'the same storage atris goal reads, still matched lowercased');
  assert.equal(board.goal_text, 'Get ten paying customers by December');
  assert.ok(fs.existsSync(path.join(ctx.root, '.atris', 'state', 'scoreboard.json')));
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).theme.text, 'Get ten paying customers by December');
  // A goal set with atris goal shows as typed in the feed too.
  const { run } = require('../commands/goal');
  const log = console.log;
  console.log = () => {};
  try { run(['set', 'Win Back The Quiet Owners', '--no-wish'], { cwd: ctx.root }); } finally { console.log = log; }
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).theme.text, 'Win Back The Quiet Owners');
  for (const bad of ['', 'x'.repeat(141), 'Win. Then win again.', 'Ship PR-12 to the repo']) {
    assert.throws(() => feed.setTheme(ctx.root, bad, { env: ctx.env }), (e) => e.status === 400, bad);
  }
  assert.throws(() => feed.setTheme(ctx.root, 'Sell more', { env: ctx.agentEnv }), (e) => e.status === 403);
});

// ----------------------------------------------------------------- propose

test('propose: why is required once a goal is set, and jargon is refused by name', (t) => {
  const ctx = project(t);
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  assert.throws(() => propose(ctx, { why: '' }), (e) => e.status === 400 && e.field === 'why' && Boolean(e.goal));
  assert.throws(() => propose(ctx, { title: 'Merge the branch into the repo' }),
    (e) => e.status === 400 && e.field === 'title' && e.remove.includes('branch') && e.remove.includes('repo'));
  assert.throws(() => propose(ctx, { visual: { kind: 'metric', label: 'Merged PRs this week', value: '12' } }),
    (e) => e.field === 'visual' && e.remove.join() === 'Merged,PRs');
  assert.throws(() => propose(ctx, { as: 'nobody' }), (e) => e.status === 404);
  const ok = propose(ctx, { detail: 'leads from the crm export, rows 4 to 6', visual: GOOD_VISUALS[0] });
  assert.equal(ok.created, true);
  assert.equal(ok.card.visual.kind, 'metric');
  assert.equal(ok.card.detail, 'leads from the crm export, rows 4 to 6');
});

test('propose: the idea must not start before a person approves it', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  const row = tasks.getTask(ctx.db, card.source.id);
  assert.equal(row.status, 'open');
  assert.equal(heldForPerson(row), 'needs_human');
  const picks = fittingTasks(tasks, ctx.db, { workspaceRoot: ctx.root, member: 'scout', job: 'build' });
  assert.ok(!picks.some((task) => task.id === row.id), 'no member run picks up a waiting idea');
});

test('propose: the same title returns the waiting card; a near copy backs it', (t) => {
  const ctx = project(t);
  const first = propose(ctx, { title: 'Recheck the last 20 results marked done and post how many are not really done' });
  const again = propose(ctx, { title: 'Recheck the last 20 results marked done and post how many are not really done' });
  assert.equal(again.created, false);
  assert.equal(again.card.id, first.card.id);
  const backed = propose(ctx, { as: 'writer', title: 'I will click through our last 20 done claims and count how many really hold up' });
  assert.equal(backed.merged, true);
  assert.equal(backed.card.id, first.card.id);
  assert.deepEqual(backed.card.backers, [{ id: 'agent:writer', name: 'writer' }]);
  assert.equal(backed.card.backer_count, 1);
  assert.equal(cards(ctx, 'needs_decision').length, 1);
  // A different target is a different idea.
  const other = propose(ctx, { as: 'closer', title: 'Draft outreach to the first five investors' });
  const owners = propose(ctx, { as: 'closer', title: 'Draft outreach to the first five customers' });
  assert.notEqual(other.card.id, owners.card.id);
});

test('propose: each member has a cap of waiting ideas', (t) => {
  const ctx = project(t);
  const env = { ...ctx.env, ATRIS_FEED_MAX_PENDING_PER_AUTHOR: '2' };
  feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the warm leads today', env });
  feed.proposeCard(ctx.root, { as: 'scout', title: 'Raise the starter price to fifty', env });
  assert.throws(() => feed.proposeCard(ctx.root, { as: 'scout', title: 'Write a short welcome video', env }), (e) => e.status === 429);
  assert.equal(feed.proposeCard(ctx.root, { as: 'writer', title: 'Write a short welcome video', env }).created, true);
});

// ------------------------------------------------------------------ decide

test('decide: approve hands the idea to its member and starts it exactly once', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  const out = feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(out.outcome.started, true);
  assert.equal(out.replayed, false);
  assert.equal(ctx.spawned.length, 1);
  assert.equal(ctx.spawned[0].member, 'scout');
  assert.equal(ctx.spawned[0].task_id, card.source.id);
  assert.equal(out.card.decision.choice, 'approve');
  assert.equal(out.card.state, 'working');
  const row = tasks.getTask(ctx.db, card.source.id);
  assert.equal(heldForPerson(row), '', 'the hold is gone, so the member run can take it');
  assert.equal(row.metadata.assigned_to, 'scout');

  const again = feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(again.replayed, true);
  const flip = feed.decide(ctx.root, card.id, 'dismiss', { env: ctx.env, deps: ctx.deps });
  assert.equal(flip.replayed, true);
  assert.equal(flip.decision.choice, 'approve', 'the first decision stands');
  assert.equal(ctx.spawned.length, 1, 'never started twice');
});

test('decide: at most two members run at once; the rest wait in order', (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const ids = ['scout', 'writer', 'closer'].map((as, i) => propose(ctx, { as, title: ['Call the warm leads today', 'Write the spring price note', 'Ask three owners for a quote'][i] }).card.id);
  const outcomes = ids.map((id) => feed.decide(ctx.root, id, 'approve', { env: ctx.env, deps: ctx.deps }).outcome);
  assert.equal(feed.FEED_MAX_RUNNING, 2);
  assert.deepEqual(outcomes.map((o) => o.started), [true, true, false]);
  assert.equal(outcomes[2].reason, 'queued');
  assert.equal(outcomes[2].position, 1);
  assert.equal(ctx.spawned.length, 2);
  assert.ok(!cards(ctx).some((card) => card.id === ids[2]), 'approved work waiting in line sits on the working shelf');
  const waiting = cards(ctx, 'working').find((card) => card.id === ids[2]);
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.run.status, 'queued');
  assert.equal(waiting.run.position, 1);

  // When the running ones end, the next in line starts.
  feed.pump(ctx.root, {
    isAlive: (pid) => pid === 999999,
    spawnRunner: (_root, entry) => { ctx.spawned.push(entry); return 999999; },
  });
  assert.equal(ctx.spawned.length, 3);
  assert.equal(ctx.spawned[2].card_id, ids[2]);
});

test('decide: the runner starts the member on the model in effect, marks the run ended and starts the next', async (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const ids = ['scout', 'writer', 'closer'].map((as, i) => propose(ctx, { as, title: ['Call the warm leads today', 'Write the spring price note', 'Ask three owners for a quote'][i] }).card.id);
  for (const id of ids) feed.decide(ctx.root, id, 'approve', { env: ctx.env, deps: ctx.deps });
  const queued = feed.readRuns(ctx.root).find((r) => r.status === 'queued');
  await assert.rejects(feed.runEntry(ctx.root, queued.id, { spawnSync: () => assert.fail('jumped the line') }), (e) => e.status === 409);
  const first = feed.readRuns(ctx.root)[0];
  const calls = [];
  await feed.runEntry(ctx.root, first.id, {
    spawnSync: (cmd, args, opts) => {
      calls.push(args);
      assert.equal(opts.env.CLAUDECODE, undefined);
      // The member finishes and hands back its result.
      require('../lib/feed-team').emit(ctx.root, { as: 'scout', type: 'result', card: first.card_id, proof: 'Called them all', env: ctx.env });
      return { status: 0 };
    },
    isAlive: (pid) => pid === process.pid,
    spawnRunner: (root, entry) => { ctx.spawned.push(entry); return process.pid; },
  });
  // The feed's default model (no roster line of its own), passed to the member's run.
  assert.deepEqual(calls[0].slice(1), ['member', 'go', 'scout', '--json', '--engine', 'codex']);
  const after = feed.readRuns(ctx.root);
  assert.equal(after.find((r) => r.id === first.id).status, 'ended');
  assert.equal(after.filter((r) => r.status === 'running').length, 2);
});

test('decide: dismiss archives the idea so it leaves every normal list', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  const out = feed.decide(ctx.root, card.id, 'dismiss', { note: 'not this month', env: ctx.env, deps: ctx.deps });
  assert.equal(out.outcome.reason, 'dismissed');
  assert.equal(ctx.spawned.length, 0);
  assert.equal(tasks.getTask(ctx.db, card.source.id).status, 'archived');
  for (const filter of ['all', 'needs_decision', 'working']) assert.deepEqual(cardsOf(ctx, card.source.id, filter), [], filter);
  const [gone] = cardsOf(ctx, card.source.id, 'dismissed');
  assert.equal(gone.decision.note, 'not this month');
});

test('decide: an agent can never decide, even with proof-only switched off', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  for (const env of [ctx.agentEnv, { ...ctx.env, ATRIS_AGENT_PROOF_ONLY: '1' }, { ...ctx.agentEnv, ATRIS_AGENT_PROOF_ONLY: '0' },
    { ...ctx.env, CODEX_THREAD_ID: 'x' }]) {
    assert.throws(() => feed.decide(ctx.root, card.id, 'approve', { env, deps: ctx.deps }), (e) => e.status === 403);
  }
  const seen = feed.listCards(ctx.root, { env: ctx.agentEnv }).cards[0];
  assert.equal(seen.can_decide, false);
  assert.match(seen.cannot_decide_reason, /person/);
  assert.equal(ctx.spawned.length, 0);
  assert.equal(cardsOf(ctx, card.source.id)[0].needs_decision, true);
});

test('decide: work in a protected lane is handed over but waits for a person to start it', (t) => {
  const ctx = project(t);
  const money = propose(ctx, { title: 'Refund the two late orders', lane: 'money' }).card;
  assert.equal(money.guarded_lane, 'money');
  const sniffed = propose(ctx, { as: 'writer', title: 'Send email to the forty quiet owners' }).card;
  assert.equal(sniffed.guarded_lane, 'customer');
  for (const card of [money, sniffed]) {
    const out = feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
    assert.equal(out.outcome.started, false);
    assert.equal(out.outcome.reason, 'guarded_lane');
    assert.equal(heldForPerson(tasks.getTask(ctx.db, card.source.id)), 'protected_lane');
  }
  assert.equal(ctx.spawned.length, 0);
});

test('decide: approving finished work goes through the human accept path', (t) => {
  const ctx = project(t);
  const id = add(ctx, { title: 'Rewrite the welcome note', status: 'review', claimedBy: 'writer' });
  const cardIdOf = cardsOf(ctx, id)[0].id;
  const refused = { accept: () => ({ ok: false, message: 'verify failed' }) };
  assert.throws(() => feed.decide(ctx.root, cardIdOf, 'approve', { env: ctx.env, deps: refused }), (e) => e.status === 409 && /verify failed/.test(e.message));
  assert.equal(cardsOf(ctx, id)[0].needs_decision, true, 'a refused accept leaves the card waiting');
  const seen = [];
  const out = feed.decide(ctx.root, cardIdOf, 'approve', { env: ctx.env, deps: { accept: (root, taskId, actor) => { seen.push([taskId, actor]); return { ok: true }; } } });
  assert.equal(out.outcome.reason, 'accepted');
  assert.deepEqual(seen, [[id, 'user:owner']]);
});

test('decide: approving a held question drops the hold and starts its member', (t) => {
  const ctx = project(t);
  const id = add(ctx, { title: 'Pick the price for the new plan', metadata: { tags: ['needs-human'], assigned_to: 'closer' } });
  const card = cardsOf(ctx, id)[0];
  const out = feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(out.outcome.started, true);
  assert.equal(ctx.spawned[0].member, 'closer');
  assert.equal(heldForPerson(tasks.getTask(ctx.db, id)), '');
});

// -------------------------------------------------------- talk and revise

test('revise: only the proposing member, only while it waits', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  assert.throws(() => feed.revise(ctx.root, card.id, { as: 'writer', title: 'Call five leads', env: ctx.env }), (e) => e.status === 403);
  assert.throws(() => feed.revise(ctx.root, card.id, { as: 'scout', title: 'Merge it into the repo', env: ctx.env }), (e) => e.remove.includes('repo'));
  const out = feed.revise(ctx.root, card.id, { as: 'scout', title: 'Call the five oldest leads', why: 'They answer most', env: ctx.env });
  assert.equal(out.card.title, 'Call the five oldest leads');
  assert.equal(out.card.why, 'They answer most');
  assert.ok(out.card.revised_at);
  feed.decide(ctx.root, card.id, 'dismiss', { env: ctx.env, deps: ctx.deps });
  assert.throws(() => feed.revise(ctx.root, card.id, { as: 'scout', title: 'Again', env: ctx.env }), (e) => e.status === 409);
});

// -------------------------------------------------------------- more ideas

// ------------------------------------------------------- list mechanics

test('list: --since returns only cards that changed, and paging walks every card', (t) => {
  const ctx = project(t);
  const a = propose(ctx, { title: 'Call the warm leads today' }).card;
  propose(ctx, { as: 'writer', title: 'Write the spring price note' });
  propose(ctx, { as: 'closer', title: 'Ask three owners for a quote' });
  const page = feed.listCards(ctx.root, { env: ctx.env });
  assert.equal(feed.listCards(ctx.root, { since: page.next_since, env: ctx.env }).cards.length, 0);
  const later = Number(page.next_since);
  while (Date.now() <= later) { /* the next write lands in a later millisecond */ }
  feed.decide(ctx.root, a.id, 'dismiss', { env: ctx.env, deps: ctx.deps });
  const delta = feed.listCards(ctx.root, { since: page.next_since, env: ctx.env }).cards;
  assert.deepEqual(delta.map((card) => card.id), [a.id], 'the dismissed card arrives so the screen can move it');
  assert.throws(() => feed.listCards(ctx.root, { since: 'yesterday-ish', env: ctx.env }), (e) => e.status === 400);

  const seen = [];
  let cursor = null;
  do {
    const one = feed.listCards(ctx.root, { limit: 1, cursor, env: ctx.env });
    seen.push(...one.cards.map((card) => card.id));
    cursor = one.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 2);
  assert.throws(() => feed.listCards(ctx.root, { filter: 'everything', env: ctx.env }), (e) => e.status === 400);
});

test('cli: atris feed cards --json answers from the fast path in the cloud shape', (t) => {
  const ctx = project(t);
  propose(ctx);
  const { spawnSync } = require('node:child_process');
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'cards', '--json'], {
    cwd: ctx.root, env: ctx.env, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const out = JSON.parse(run.stdout);
  assert.equal(out.version, 'atris.feed.v1');
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].can_decide, true);
  const refused = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'decide', out.cards[0].id, 'approve', '--json'], {
    cwd: ctx.root, env: ctx.agentEnv, encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.status, 403);
});

// --------------------------------------------------------- reading queue

function backdatePass(ctx, cardId, minutes) {
  tasks.updateTaskMetadata(ctx.db, cardId.split(':')[1], (m) => {
    for (const entry of Object.values(m.feed_views[cardId])) entry.last_passed_at = new Date(Date.now() - minutes * 60000).toISOString();
    return m;
  }, { touch: false });
}

test('queue: ideas first (never passed, then fewest passes, oldest first so new ideas land at the end), then unread results oldest first', (t) => {
  const ctx = project(t);
  const older = add(ctx, { title: 'Send the weekly note', status: 'done' });
  const newer = add(ctx, { title: 'Send the monthly note', status: 'done' });
  tasks.updateTaskMetadata(ctx.db, older, (m) => m, { now: Date.now() - 60000 });
  const a = propose(ctx, { title: 'Call the warm leads today' }).card;
  const b = propose(ctx, { as: 'writer', title: 'Write the spring price note' }).card;
  const c = propose(ctx, { as: 'closer', title: 'Ask three owners for a quote' }).card;
  feed.passCards(ctx.root, [a.id], { env: ctx.env, now: Date.now() + 11000 });
  backdatePass(ctx, a.id, 31); // passed, but long enough ago to come back
  const order = cards(ctx).map((card) => card.id);
  const ideas = order.slice(0, 3);
  assert.deepEqual(ideas, [b.id, c.id, a.id], 'never-passed oldest first, the passed one last');
  const results = order.slice(3);
  assert.equal(results.length, 2);
  assert.equal(cards(ctx).find((card) => card.id === a.id).pass_count, 1);
  const page = feed.listCards(ctx.root, { env: ctx.env });
  assert.deepEqual(Object.keys(page.counts).sort(), ['done_today', 'needs_decision', 'new_results', 'parked', 'working']);
  assert.equal(page.counts.new_results, 2);
  void newer;
});

test('queue: a pass holds an idea back for 30 minutes; three passes park it; revising brings it back', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  assert.equal(feed.passCards(ctx.root, [card.id], { env: ctx.env, now: Date.now() + 11000 }).passed, 1);
  assert.ok(!cards(ctx).some((c) => c.id === card.id), 'held back right after a pass');
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.needs_decision, 1, 'still counted as waiting');
  backdatePass(ctx, card.id, 31);
  assert.ok(cards(ctx).some((c) => c.id === card.id), 'back after 30 minutes');
  feed.passCards(ctx.root, [card.id], { env: ctx.env, now: Date.now() + 11000 });
  feed.passCards(ctx.root, [card.id], { env: ctx.env, now: Date.now() + 11000 });
  backdatePass(ctx, card.id, 31);
  assert.ok(!cards(ctx).some((c) => c.id === card.id), 'parked after three passes');
  assert.deepEqual(cards(ctx, 'parked').map((c) => c.id), [card.id]);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.parked, 1);
  assert.equal(tasks.getTask(ctx.db, card.source.id).status, 'open', 'a pass is not a dismissal');
  feed.revise(ctx.root, card.id, { as: 'scout', title: 'Call the five oldest leads', env: ctx.env });
  const back = cards(ctx).find((c) => c.id === card.id);
  assert.ok(back, 'revising brings it back');
  assert.equal(back.pass_count, 0);
  assert.throws(() => feed.passCards(ctx.root, [card.id], { env: ctx.agentEnv, now: Date.now() + 11000 }), (e) => e.status === 403);
});

test('queue: a read result leaves the default list and stays under done', (t) => {
  const ctx = project(t);
  const done = add(ctx, { title: 'Send the weekly note', status: 'done' });
  const [result] = cardsOf(ctx, done);
  assert.equal(result.seen, false);
  feed.passCards(ctx.root, [result.id], { env: ctx.env, now: Date.now() + 11000 });
  assert.deepEqual(cardsOf(ctx, done), [], 'read results leave the default list');
  const [kept] = cardsOf(ctx, done, 'done');
  assert.equal(kept.seen, true);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.new_results, 0);
  const working = add(ctx, { title: 'Sort the inbox', status: 'claimed', claimedBy: 'scout' });
  const out = feed.passCards(ctx.root, [cardsOf(ctx, working, 'working')[0].id, 'task:nope:1:proposal'], { env: ctx.env, now: Date.now() + 11000 });
  assert.equal(out.passed, 0, 'only waiting ideas and results take a pass');
  assert.equal(out.skipped.length, 2);
});

test('queue: the cursor names cards already sent, so a pass between pages skips nothing', (t) => {
  const ctx = project(t);
  const ids = ['Call the warm leads today', 'Write the spring price note', 'Ask three owners for a quote']
    .map((title, i) => propose(ctx, { as: ['scout', 'writer', 'closer'][i], title }).card.id);
  const first = feed.listCards(ctx.root, { limit: 1, env: ctx.env });
  feed.passCards(ctx.root, [first.cards[0].id], { env: ctx.env, now: Date.now() + 11000 });
  const second = feed.listCards(ctx.root, { limit: 5, cursor: first.next_cursor, env: ctx.env });
  const seen = [...first.cards, ...second.cards].map((card) => card.id);
  assert.equal(new Set(seen).size, seen.length, 'no card repeats');
  assert.equal(seen.length, 3, 'every card arrives once, though the first was passed and moved');
  assert.deepEqual([...seen].sort(), [...ids].sort());
  assert.throws(() => feed.listCards(ctx.root, { cursor: 'not a cursor!', env: ctx.env }), (e) => e.status === 400);
});

test('cli: a bare call whose output is not a terminal keeps the old group feed for one release, and says so', (t) => {
  const ctx = project(t);
  const { spawnSync } = require('node:child_process');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const bare = spawnSync(process.execPath, [cli, 'feed'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.match(bare.stderr, /^note: bare `atris feed` now opens the decision feed/);
  assert.match(bare.stderr, /No \.atris\/business\.json found/, 'then the old group feed answered, as before');
  const json = spawnSync(process.execPath, [cli, 'feed', '--json'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.equal(json.stderr, '');
  assert.equal(JSON.parse(json.stdout).version, 'atris.feed.v1');
  const help = spawnSync(process.execPath, [cli, 'feed', '--help'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8' });
  assert.match(help.stdout, /bare `atris feed` now opens this decision feed/);
});

test('routing: feed list and feed post stay the business group feed', () => {
  assert.equal(handles([], { isTTY: true }), true);
  assert.equal(handles(['--json']), true);
  assert.equal(handles(['cards', '--since', '123']), true);
  assert.equal(handles(['decide', 'task:x:1:proposal', 'approve']), true);
  assert.equal(handles(['list']), false);
  assert.equal(handles(['post', 'shipped it']), false);
  assert.equal(handles(['--author', 'mira']), false);
  assert.equal(handles(['--since', '7d']), false);
  const { route } = require('../commands/decision-feed');
  assert.deepEqual(route([], { isTTY: true }), { decision: true, notice: '' });
  assert.equal(route([], { isTTY: false }).decision, false);
  assert.match(route([], { isTTY: false }).notice, /now opens the decision feed/);
  assert.equal(route(['--json'], { isTTY: false }).decision, true);
  assert.equal(route(['--limit', '5'], { isTTY: false }).decision, false);
  assert.equal(route(['cards'], { isTTY: false }).decision, true);
});

// ------------------------------------------- what a card you can approve says

test('held work you can approve says what you get: the member who does it, why, and what done looks like; never the question line', (t) => {
  const ctx = project(t);
  const id = add(ctx, {
    title: 'Fix BCK-1234 in backend/services/feed.py',
    metadata: {
      tags: ['needs-human'], assigned_to: 'closer',
      why_it_matters: 'An unset cap now holds the team all day.',
      done_looks_like: 'An unset cap means no cap. Teammates that are always on keep working.',
    },
  });
  const [card] = cardsOf(ctx, id);
  assert.equal(card.kind, 'question');
  assert.equal(card.can_decide, true);
  assert.equal(card.title, 'An unset cap means no cap.');
  assert.notEqual(card.title, 'A team member has a question for you');
  assert.equal(card.author.id, 'agent:closer');
  assert.equal(card.why, 'An unset cap now holds the team all day.');
  assert.deepEqual(card.story, ['Teammates that are always on keep working.'], 'the title is not said twice');
  // A plain job title stays, with its plan, and no assignee but a team author still names who does it.
  const own = add(ctx, { title: 'Stop an unset spend cap from holding the team', metadata: { tags: ['decision'], feed: { author: 'agent:writer' }, done_looks_like: 'The team keeps working with no cap set.' } });
  const [plain] = cardsOf(ctx, own);
  assert.equal(plain.title, 'Stop an unset spend cap from holding the team');
  assert.equal(plain.author.id, 'agent:writer');
  assert.deepEqual(plain.story, ['The team keeps working with no cap set.']);
  // Approve still hands it to that member and starts it, as before.
  const out = feed.decide(ctx.root, plain.id, 'approve', { env: ctx.env, deps: ctx.deps });
  assert.equal(out.outcome.started, true);
  assert.equal(ctx.spawned[0].member, 'writer');
});

test('held work with no plain words and nothing explaining it stays off the main list, reachable under needs_decision, never titled as a question', (t) => {
  const ctx = project(t);
  const id = add(ctx, { title: 'Fix BCK-1234 in backend/services/feed.py', metadata: { tags: ['needs-human'], assigned_to: 'closer' } });
  assert.deepEqual(cardsOf(ctx, id), [], 'off the main list');
  const [card] = cardsOf(ctx, id, 'needs_decision');
  assert.equal(card.title, 'Work waiting for your yes, not yet written in plain words');
  assert.equal(card.needs_decision, true);
  assert.match(card.detail, /BCK-1234/, 'the raw words kept behind the detail');
});

test('a teammate\'s question is answered in the comments, never approved; it can still be talked over and dismissed', async (t) => {
  const ctx = project(t);
  const asked = feed.proposeCard(ctx.root, { as: 'scout', kind: 'question', title: 'Which city should we start in?', why: 'The first city sets the plan', env: ctx.env }).card;
  assert.equal(asked.kind, 'question');
  assert.equal(asked.needs_decision, true);
  assert.equal(asked.can_decide, false);
  assert.equal(asked.cannot_decide_reason, 'This asks you something. Answer it in the comments.');
  assert.throws(() => feed.decide(ctx.root, asked.id, 'approve', { env: ctx.env, deps: ctx.deps }), (e) => e.status === 409 && /Answer it in the comments/.test(e.message));
  assert.equal(ctx.spawned.length, 0, 'nothing started');
  const talked = await feed.talk(ctx.root, asked.id, 'Start in Austin.', { env: ctx.env, deps: ctx.deps });
  assert.ok(talked.message, 'talking on it still works');
  // A proposal is untouched: still approvable.
  assert.equal(propose(ctx).card.can_decide, true);
  const out = feed.dismissCards(ctx.root, [asked.id], { env: ctx.env, deps: ctx.deps });
  assert.deepEqual(out.skipped || [], []);
  assert.equal(cardsOf(ctx, asked.source.id).length, 0);
});

test('a teammate\'s question you answered in the comments stops asking for you: a reaction or a teammate\'s comment does not settle it, and it is never approvable', (t) => {
  const ctx = project(t);
  const room = require('../lib/feed-room');
  const asked = feed.proposeCard(ctx.root, { as: 'scout', kind: 'question', title: 'Which city should we start in?', why: 'The first city sets the plan', env: ctx.env }).card;
  const page = () => feed.listCards(ctx.root, { limit: 100, env: ctx.env });
  const mine = () => page().cards.find((card) => card.id === asked.id);
  const waiting = () => cards(ctx, 'needs_decision').some((card) => card.id === asked.id);
  assert.equal(mine().needs_decision, true, 'an asked question needs you');
  assert.ok(waiting());
  const before = page().counts.needs_decision;

  // A reaction and a teammate's comment are not your answer.
  room.react(ctx.root, asked.id, room.EMOJI[0], { env: ctx.env });
  room.reply(ctx.root, asked.id, 'Austin has the most leads.', { as: 'writer', direct: true, env: ctx.env, deps: ctx.deps });
  assert.equal(mine().needs_decision, true, 'a reaction or a teammate comment does not settle it');
  assert.equal(page().counts.needs_decision, before);
  assert.equal(mine().can_decide, false);

  // Your comment answers it: it leaves the needs_decision list and count, stays on the main list while fresh.
  const said = room.reply(ctx.root, asked.id, 'Start in Austin.', { env: ctx.env, deps: ctx.deps });
  assert.equal(said.card.needs_decision, false, 'the card handed back after your comment no longer needs you');
  const card = mine();
  assert.ok(card, 'still on the main list while the talk is fresh');
  assert.equal(card.needs_decision, false);
  assert.equal(card.can_decide, false);
  assert.ok(!waiting(), 'off the needs_decision list');
  assert.equal(page().counts.needs_decision, before - 1, 'the count drops');
  assert.equal(feed.readCard(ctx.root, asked.id, { env: ctx.env }).needs_decision, false);
  assert.throws(() => feed.decide(ctx.root, asked.id, 'approve', { env: ctx.env, deps: ctx.deps }), (e) => e.status === 409);
  assert.equal(ctx.spawned.length, 0, 'nothing started');

  // The one who asked asks again: one answer settles the card, it does not come back.
  room.reply(ctx.root, asked.id, 'Austin it is. Should we also try Dallas next?', { as: 'scout', direct: true, env: ctx.env, deps: ctx.deps });
  assert.equal(mine().needs_decision, false, 'a follow-up question does not bring it back');
  assert.equal(page().counts.needs_decision, before - 1);

  // Quiet for a day, like any other card: it leaves the main list.
  ageTask(ctx, asked.source.id, 30);
  const social = room.socialFile(ctx.root);
  const old = new Date(Date.now() - 26 * 3600000).toISOString();
  const stored = JSON.parse(fs.readFileSync(social, 'utf8'));
  for (const entry of Object.values(stored)) { entry.updated_at = old; for (const reply of entry.replies || []) reply.at = old; }
  fs.writeFileSync(social, JSON.stringify(stored));
  assert.equal(mine(), undefined, 'an answered question quiet for a day leaves the main list');
});

test('work that ended with nothing says why in words: a status code like tick-ok is said plainly, an unknown one and an exit number say nothing', (t) => {
  const ctx = project(t);
  const why = feed._internal.endedWhy;
  const log = (text) => { const file = path.join(ctx.dir, `run-${Math.random().toString(16).slice(2)}.log`); fs.writeFileSync(file, text); return file; };
  assert.equal(why(log('{"status":"ran","reason":"tick-ok","ran":true}\n')), ': the teammate took a step but wrote no result');
  assert.equal(why(log('{"reason":"wall_exceeded_during_tick"}\n')), ': it ran out of time');
  assert.equal(why(log('{"reason":"some-new-code"}\n')), '', 'an unknown code says nothing');
  assert.equal(why(log('The model said the page was already right.\n')), ': The model said the page was already right');
  assert.equal(why(log('Error: ENOENT at lib/x.js:12\n')), '', 'machine words stay in the log');
  assert.equal(why(path.join(ctx.dir, 'missing.log')), '');
  for (const code of ['tick-ok', 'rate-limited', 'quiet-hours', 'no-ready-engine', 'session-lock-busy', 'verify-did-not-run', 'verifier-not-passed', 'commit-failed', 'push-rejected', 'workspace-dirty-in-member-scope', 'member-archived', 'mission-not-found', 'dry-run', 'skipped-llm-not-configured']) {
    const said = why(log(`{"reason":"${code}"}`));
    assert.ok(said && feed._internal.isPlainWords(said.slice(2)), `${code} reads plainly: ${said}`);
    assert.doesNotMatch(`The work ended without a result${said}.`, /\(|tick|exit/);
  }
});

test('a running card says how many minutes it may take: run.limit_minutes, from the same limit that stops it', (t) => {
  const ctx = project(t);
  const view = feed._internal.runView;
  const saved = { work: process.env.ATRIS_FEED_WORK_LIMIT_MINUTES, ping: process.env.ATRIS_FEED_PING_LIMIT_MINUTES };
  t.after(() => {
    for (const [key, name] of [['work', 'ATRIS_FEED_WORK_LIMIT_MINUTES'], ['ping', 'ATRIS_FEED_PING_LIMIT_MINUTES']]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  });
  delete process.env.ATRIS_FEED_WORK_LIMIT_MINUTES;
  delete process.env.ATRIS_FEED_PING_LIMIT_MINUTES;
  assert.equal(view({ status: 'running', kind: 'task' }, []).limit_minutes, 45);
  assert.equal(view({ status: 'running', kind: 'ping' }, []).limit_minutes, 6);
  process.env.ATRIS_FEED_WORK_LIMIT_MINUTES = '20';
  assert.equal(view({ status: 'running', kind: 'task' }, []).limit_minutes, 20);
  assert.equal('limit_minutes' in view({ status: 'queued', kind: 'task' }, [{ status: 'queued', kind: 'task' }]), false, 'only while running');
  // On the real card of approved work that started.
  const idea = propose(ctx).card;
  feed.decide(ctx.root, idea.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const running = cards(ctx, 'working').find((card) => card.id === idea.id);
  assert.equal(running.run.status, 'running');
  assert.equal(running.run.limit_minutes, 20);
});
