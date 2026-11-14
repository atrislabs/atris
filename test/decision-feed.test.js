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

const AGENT_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT', 'DEVIN_SESSION_ID',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_MISSION_DRIVER_DETACHED', 'ATRIS_MISSION_DRIVER_PARENT_PID',
  'ATRIS_DISPATCH_DEPTH', 'ATRIS_AGENT_PROOF_ONLY',
];

function project(t, members = ['scout', 'writer', 'closer']) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decision-feed-')));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# atris\n');
  for (const name of members) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n# ${name}\n`);
  }
  const dbPath = path.join(dir, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = tasks.open(dbPath);
  const env = { ...process.env, ATRIS_TASKS_DB: dbPath, USER: 'owner' };
  for (const marker of AGENT_MARKERS) delete env[marker];
  const spawned = [];
  const deps = {
    spawnRunner: (_root, entry) => { spawned.push(entry); return process.pid; },
    isAlive: () => true,
  };
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { root, db, env, deps, spawned, agentEnv: { ...env, CLAUDECODE: '1' } };
}

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

test('cards: a jargon title is kept in detail, never shown', (t) => {
  const ctx = project(t);
  const done = add(ctx, { title: 'Merged PR-12 into the repo', status: 'done' });
  const [card] = cardsOf(ctx, done);
  assert.equal(card.title, 'A piece of work finished');
  assert.match(card.detail, /PR-12/);
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

test('decide: the runner starts the member, marks the run ended and starts the next', (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer']);
  const ids = ['scout', 'writer', 'closer'].map((as, i) => propose(ctx, { as, title: ['Call the warm leads today', 'Write the spring price note', 'Ask three owners for a quote'][i] }).card.id);
  for (const id of ids) feed.decide(ctx.root, id, 'approve', { env: ctx.env, deps: ctx.deps });
  const queued = feed.readRuns(ctx.root).find((r) => r.status === 'queued');
  assert.throws(() => feed.runEntry(ctx.root, queued.id, { spawnSync: () => assert.fail('jumped the line') }), (e) => e.status === 409);
  const first = feed.readRuns(ctx.root)[0];
  const calls = [];
  feed.runEntry(ctx.root, first.id, {
    spawnSync: (cmd, args) => { calls.push(args); return { status: 0 }; },
    isAlive: (pid) => pid === process.pid,
    spawnRunner: (root, entry) => { ctx.spawned.push(entry); return process.pid; },
  });
  assert.deepEqual(calls[0].slice(1), ['member', 'go', 'scout', '--json']);
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

test('talk: the person writes on the task, the member answers on its next run', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  const sent = feed.talk(ctx.root, card.id, 'Can we start with the five oldest?', { env: ctx.env });
  assert.equal(sent.reply_pending, true);
  assert.equal(sent.message.from.type, 'user');
  let thread = feed.listMessages(ctx.root, card.id, { env: ctx.env });
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.reply_pending, true);
  const events = tasks.listTaskEvents(ctx.db, { taskId: card.source.id }).filter((e) => e.event_type === 'message');
  assert.equal(events.length, 1, 'stored on the task history');
  assert.throws(() => feed.talk(ctx.root, card.id, 'I will', { as: 'writer', env: ctx.agentEnv }), (e) => e.status === 403);
  assert.throws(() => feed.talk(ctx.root, card.id, 'I will merge the branch', { as: 'scout', env: ctx.agentEnv }), (e) => e.remove.includes('branch'));
  feed.talk(ctx.root, card.id, 'Yes, I will start with the five oldest.', { as: 'scout', env: ctx.agentEnv });
  thread = feed.listMessages(ctx.root, card.id, { env: ctx.env });
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.reply_pending, false);
  assert.equal(cardsOf(ctx, card.source.id)[0].message_count, 2);
  assert.throws(() => feed.talk(ctx.root, card.id, 'hello', { env: ctx.agentEnv }), (e) => e.status === 403, 'an agent cannot talk as the person');
});

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

test('more: asks up to three members, one at a time, under a daily cap, and fails closed', (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  assert.match(feed.requestMoreIdeas(ctx.root, { env: ctx.env, deps: ctx.deps }).reason, /goal first/);
  assert.equal(ctx.spawned.length, 0);
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  const liked = propose(ctx, { title: 'Call the warm leads today' }).card;
  feed.decide(ctx.root, liked.id, 'dismiss', { note: 'phones are slow', env: ctx.env, deps: ctx.deps });
  const env = { ...ctx.env, ATRIS_FEED_MAX_REFILLS_PER_DAY: '1' };
  assert.throws(() => feed.requestMoreIdeas(ctx.root, { env: ctx.agentEnv, deps: ctx.deps }), (e) => e.status === 403);
  const out = feed.requestMoreIdeas(ctx.root, { env, deps: ctx.deps });
  assert.equal(out.requested, 3);
  const ideas = feed.readRuns(ctx.root).filter((r) => r.kind === 'ideas');
  assert.equal(ideas.length, 3);
  assert.equal(ideas.filter((r) => r.status === 'running').length, 1, 'one idea run at a time');
  assert.match(ideas[0].direction, /atris feed propose --as/);
  assert.match(ideas[0].direction, /phones are slow/, 'the person\'s no and note are taste');
  assert.match(feed.requestMoreIdeas(ctx.root, { env, deps: ctx.deps }).reason, /already working/);
  // Once those runs end, the daily cap holds.
  const done = { ...ctx.deps, isAlive: () => false, spawnRunner: () => { throw new Error('should not start'); } };
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'runs.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of data.entries) entry.status = 'ended';
  fs.writeFileSync(file, JSON.stringify(data));
  assert.match(feed.requestMoreIdeas(ctx.root, { env, deps: done }).reason, /as often as allowed today/);
});

test('more: no new round while six ideas already wait', (t) => {
  const ctx = project(t);
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  const titles = ['Call the warm leads today', 'Raise the starter price', 'Write a short welcome video',
    'Ask three owners for a quote', 'Send the spring price note', 'Thank the first ten buyers'];
  titles.forEach((title, i) => propose(ctx, { as: ['scout', 'writer', 'closer'][i % 3], title }));
  assert.match(feed.requestMoreIdeas(ctx.root, { env: ctx.env, deps: ctx.deps }).reason, /6 ideas are already waiting/);
  assert.equal(ctx.spawned.length, 0);
});

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

// ------------------------------------------------------- talk gets an answer

function backdatePass(ctx, cardId, minutes) {
  tasks.updateTaskMetadata(ctx.db, cardId.split(':')[1], (m) => {
    for (const entry of Object.values(m.feed_views[cardId])) entry.last_passed_at = new Date(Date.now() - minutes * 60000).toISOString();
    return m;
  }, { touch: false });
}

test('talk: a message queues one short answer run of the card\'s member', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  const sent = feed.talk(ctx.root, card.id, 'Can we start with the five oldest?', { env: ctx.env, deps: ctx.deps });
  assert.equal(sent.reply_pending, true);
  assert.equal(sent.reply_run.status, 'running');
  assert.equal(ctx.spawned.length, 1);
  assert.equal(ctx.spawned[0].kind, 'reply');
  assert.equal(ctx.spawned[0].member, 'scout');
  assert.match(ctx.spawned[0].direction, /Do not start the work/);
  assert.match(ctx.spawned[0].direction, new RegExp(`atris feed talk <card> --as scout`));
  assert.match(ctx.spawned[0].direction, new RegExp(card.id));
  assert.match(ctx.spawned[0].direction, /five oldest/);
  assert.match(ctx.spawned[0].direction, /atris feed revise <card> --as scout/);
  // A second message while that run is live adds no second run for this card.
  feed.talk(ctx.root, card.id, 'Or the ten newest?', { env: ctx.env, deps: ctx.deps });
  assert.equal(ctx.spawned.length, 1);
  assert.equal(feed.readRuns(ctx.root).filter((r) => r.kind === 'reply').length, 1);
  assert.equal(feed.listMessages(ctx.root, card.id, { env: ctx.env }).reply_pending, true);
  // The reply run does not stand in for the card's approved work on the card.
  assert.equal(cards(ctx).find((c) => c.id === card.id).run, null);
  feed.talk(ctx.root, card.id, 'The five oldest answer most, so I will start there.', { as: 'scout', env: ctx.agentEnv, deps: ctx.deps });
  assert.equal(feed.listMessages(ctx.root, card.id, { env: ctx.env }).reply_pending, false);
});

test('talk: a reply run waits behind approved work and ahead of idea rounds; answering cancels it', (t) => {
  const ctx = project(t, ['scout', 'writer', 'closer', 'extra']);
  const blocked = { ...ctx.deps, maxRunning: 0 };
  feed.setTheme(ctx.root, 'Get ten paying customers by December', { env: ctx.env });
  const idea = propose(ctx, { as: 'extra', title: 'Thank the first ten buyers' }).card;
  feed.requestMoreIdeas(ctx.root, { env: ctx.env, deps: blocked });
  feed.talk(ctx.root, idea.id, 'Which ten?', { env: ctx.env, deps: blocked });
  const approved = propose(ctx, { as: 'writer', title: 'Write the spring price note' }).card;
  feed.decide(ctx.root, approved.id, 'approve', { env: ctx.env, deps: blocked });
  assert.equal(ctx.spawned.length, 0, 'nothing ran with no free slot');
  feed.pump(ctx.root, { ...ctx.deps, maxRunning: 1 });
  assert.equal(ctx.spawned[0].kind, 'task', 'approved work first');
  feed.pump(ctx.root, { ...ctx.deps, maxRunning: 2 });
  assert.equal(ctx.spawned[1].kind, 'reply', 'then the answer');
  feed.pump(ctx.root, { ...ctx.deps, maxRunning: 3 });
  assert.equal(ctx.spawned[2].kind, 'ideas', 'then idea rounds');

  const second = propose(ctx, { as: 'closer', title: 'Ask three owners for a quote' }).card;
  feed.talk(ctx.root, second.id, 'Which owners?', { env: ctx.env, deps: blocked });
  feed.talk(ctx.root, second.id, 'The three who called last week.', { as: 'closer', env: ctx.agentEnv, deps: blocked });
  assert.equal(feed.readRuns(ctx.root).find((r) => r.key === `reply:${second.id}`).status, 'cancelled');
});

test('talk: any run of the member starts with the person\'s waiting messages', (t) => {
  const ctx = project(t);
  const { card } = propose(ctx);
  assert.deepEqual(feed.talkBriefLines(ctx.root, 'scout'), []);
  feed.talk(ctx.root, card.id, 'Please make it the five oldest instead', { env: ctx.env, deps: { ...ctx.deps, maxRunning: 0 } });
  const lines = feed.talkBriefLines(ctx.root, 'scout');
  assert.match(lines[0], /waiting on your answer/);
  assert.ok(lines.some((line) => line.includes(card.id) && line.includes('five oldest instead')));
  assert.deepEqual(feed.talkBriefLines(ctx.root, 'writer'), [], 'only the member\'s own cards');

  const { buildTickPrompt } = require('../commands/mission');
  const tick = buildTickPrompt({ id: 'm1', owner: 'scout', objective: 'Tidy the inbox', status: 'running' }, 1, 1,
    { lane: 'code', verifier: '' }, [], ctx.root);
  const firstSection = tick.split('\n').slice(0, 4).join('\n');
  assert.match(firstSection, /waiting on your answer/, 'the brief begins with it');
  const { buildMemberSubagentShell } = require('../commands/member');
  assert.match(buildMemberSubagentShell('scout', 'Scout', 'claude', 'Tidy the inbox', ctx.root).prompt, /^## The owner is waiting on your answer/);
  assert.doesNotMatch(buildMemberSubagentShell('writer', 'Writer', 'claude', 'Tidy the inbox', ctx.root).prompt, /waiting on your answer/);

  feed.talk(ctx.root, card.id, 'Yes, the five oldest it is.', { as: 'scout', env: ctx.agentEnv, deps: ctx.deps });
  assert.deepEqual(feed.talkBriefLines(ctx.root, 'scout'), []);
});

// --------------------------------------------------------- reading queue

test('queue: ideas first (never passed, then fewest passes, then newest), then unread results oldest first', (t) => {
  const ctx = project(t);
  const older = add(ctx, { title: 'Send the weekly note', status: 'done' });
  const newer = add(ctx, { title: 'Send the monthly note', status: 'done' });
  tasks.updateTaskMetadata(ctx.db, older, (m) => m, { now: Date.now() - 60000 });
  const a = propose(ctx, { title: 'Call the warm leads today' }).card;
  const b = propose(ctx, { as: 'writer', title: 'Write the spring price note' }).card;
  const c = propose(ctx, { as: 'closer', title: 'Ask three owners for a quote' }).card;
  feed.passCards(ctx.root, [a.id], { env: ctx.env });
  backdatePass(ctx, a.id, 31); // passed, but long enough ago to come back
  const order = cards(ctx).map((card) => card.id);
  const ideas = order.slice(0, 3);
  assert.deepEqual(ideas, [c.id, b.id, a.id], 'never-passed newest first, the passed one last');
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
  assert.equal(feed.passCards(ctx.root, [card.id], { env: ctx.env }).passed, 1);
  assert.ok(!cards(ctx).some((c) => c.id === card.id), 'held back right after a pass');
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.needs_decision, 1, 'still counted as waiting');
  backdatePass(ctx, card.id, 31);
  assert.ok(cards(ctx).some((c) => c.id === card.id), 'back after 30 minutes');
  feed.passCards(ctx.root, [card.id], { env: ctx.env });
  feed.passCards(ctx.root, [card.id], { env: ctx.env });
  backdatePass(ctx, card.id, 31);
  assert.ok(!cards(ctx).some((c) => c.id === card.id), 'parked after three passes');
  assert.deepEqual(cards(ctx, 'parked').map((c) => c.id), [card.id]);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.parked, 1);
  assert.equal(tasks.getTask(ctx.db, card.source.id).status, 'open', 'a pass is not a dismissal');
  feed.revise(ctx.root, card.id, { as: 'scout', title: 'Call the five oldest leads', env: ctx.env });
  const back = cards(ctx).find((c) => c.id === card.id);
  assert.ok(back, 'revising brings it back');
  assert.equal(back.pass_count, 0);
  assert.throws(() => feed.passCards(ctx.root, [card.id], { env: ctx.agentEnv }), (e) => e.status === 403);
});

test('queue: a read result leaves the default list and stays under done', (t) => {
  const ctx = project(t);
  const done = add(ctx, { title: 'Send the weekly note', status: 'done' });
  const [result] = cardsOf(ctx, done);
  assert.equal(result.seen, false);
  feed.passCards(ctx.root, [result.id], { env: ctx.env });
  assert.deepEqual(cardsOf(ctx, done), [], 'read results leave the default list');
  const [kept] = cardsOf(ctx, done, 'done');
  assert.equal(kept.seen, true);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).counts.new_results, 0);
  const working = add(ctx, { title: 'Sort the inbox', status: 'claimed', claimedBy: 'scout' });
  const out = feed.passCards(ctx.root, [cardsOf(ctx, working, 'working')[0].id, 'task:nope:1:proposal'], { env: ctx.env });
  assert.equal(out.passed, 0, 'only waiting ideas and results take a pass');
  assert.equal(out.skipped.length, 2);
});

test('queue: the cursor names cards already sent, so a pass between pages skips nothing', (t) => {
  const ctx = project(t);
  const ids = ['Call the warm leads today', 'Write the spring price note', 'Ask three owners for a quote']
    .map((title, i) => propose(ctx, { as: ['scout', 'writer', 'closer'][i], title }).card.id);
  const first = feed.listCards(ctx.root, { limit: 1, env: ctx.env });
  feed.passCards(ctx.root, [first.cards[0].id], { env: ctx.env });
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
